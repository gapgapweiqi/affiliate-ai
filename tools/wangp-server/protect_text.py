"""
Keep text legible in image-to-video output.

Video models redraw every frame, and small printed text (prices, feature
labels, logos) drifts into gibberish after a second or two. Shopee product
images are mostly marketing graphics full of such text.

Fix: OCR the start image, then paste the start image's pixels back over the
text regions in every frame, with a feathered edge. Works best with a
locked-off camera prompt so the regions stay aligned; the product and light
effects keep moving everywhere else.
"""

from __future__ import annotations

from pathlib import Path

import cv2
import imageio.v2 as imageio
import numpy as np

_ocr = None


def _get_ocr():
    global _ocr
    if _ocr is None:
        from rapidocr_onnxruntime import RapidOCR

        _ocr = RapidOCR()
    return _ocr


def text_mask(image: np.ndarray, min_conf: float = 0.5) -> tuple[np.ndarray, int]:
    """Float mask (0..1, HxW) covering detected text, feathered. Returns (mask, n_boxes)."""
    h, w = image.shape[:2]
    result, _ = _get_ocr()(image)
    mask = np.zeros((h, w), np.uint8)
    n = 0
    for box, _txt, conf in result or []:
        if float(conf) < min_conf:
            continue
        pts = np.array(box, np.float32)
        x0, y0 = pts.min(0)
        x1, y1 = pts.max(0)
        bh = y1 - y0
        # pad: text glyph boxes are tight; labels often sit on pills/icons
        px, py = bh * 1.6, bh * 0.45
        cv2.rectangle(
            mask,
            (int(max(0, x0 - px)), int(max(0, y0 - py))),
            (int(min(w - 1, x1 + px)), int(min(h - 1, y1 + py))),
            255,
            -1,
        )
        n += 1
    if n == 0:
        return mask.astype(np.float32), 0
    k = max(3, (min(h, w) // 80) | 1)  # odd feather kernel, ~1% of frame
    soft = cv2.GaussianBlur(mask, (k * 2 + 1, k * 2 + 1), 0).astype(np.float32) / 255.0
    return soft, n


def protect_text(video_path: Path, start_image_path: Path) -> int:
    """Rewrite video_path in place. Returns the number of text boxes protected (0 = untouched)."""
    reader = imageio.get_reader(str(video_path), format="ffmpeg")
    meta = reader.get_meta_data()
    fps = meta.get("fps", 24)
    frames = [f for f in reader]
    reader.close()
    if not frames:
        return 0
    fh, fw = frames[0].shape[:2]

    src = cv2.imread(str(start_image_path), cv2.IMREAD_COLOR)
    if src is None:
        return 0
    src = cv2.cvtColor(src, cv2.COLOR_BGR2RGB)
    # WanGP fits the start image to the output frame; match it by
    # center-cropping to the frame's aspect, then resizing.
    sh, sw = src.shape[:2]
    target = fw / fh
    if sw / sh > target:
        nw = int(sh * target)
        src = src[:, (sw - nw) // 2 : (sw - nw) // 2 + nw]
    elif sw / sh < target:
        nh = int(sw / target)
        src = src[(sh - nh) // 2 : (sh - nh) // 2 + nh]
    src = cv2.resize(src, (fw, fh), interpolation=cv2.INTER_AREA)

    mask, n = text_mask(src)
    if n == 0:
        return 0
    m = mask[..., None]
    src_f = src.astype(np.float32)

    tmp = video_path.with_suffix(".protect.mp4")
    writer = imageio.get_writer(
        str(tmp), format="ffmpeg", fps=fps, codec="libx264", quality=8,
        pixelformat="yuv420p", macro_block_size=1,
    )
    for f in frames:
        out = f.astype(np.float32) * (1 - m) + src_f * m
        writer.append_data(out.clip(0, 255).astype(np.uint8))
    writer.close()
    tmp.replace(video_path)
    return n
