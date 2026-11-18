-- Sample data for local preview only (fake products). Safe to re-run.
BEGIN;
DELETE FROM products WHERE external_id LIKE 'demo-%';
DELETE FROM shops WHERE external_id = 'demo-shop';

INSERT INTO shops (platform, external_id, name, is_mall, rating)
VALUES ('shopee', 'demo-shop', 'Demo Official Store', true, 4.9);

INSERT INTO products (platform, external_id, shop_id, name, slug, brand, description, primary_image,
  current_price, original_price, discount_percent, rating, rating_count, sold_count, final_score, niche, translations)
SELECT 'shopee', 'demo-' || n, (SELECT id FROM shops WHERE external_id='demo-shop'),
  th, slug, brand, th_desc,
  'https://placehold.co/600x600/' || color || '/ffffff/png?text=' || replace(brand, ' ', '+'),
  price * 100, orig * 100, CASE WHEN orig > price THEN (orig - price)::real / orig END,
  rating, rcount, sold, score, niche::niche,
  jsonb_build_object('en', jsonb_build_object('name', en, 'description', en_desc),
                     'zh', jsonb_build_object('name', en, 'description', en_desc),
                     'ja', jsonb_build_object('name', en, 'description', en_desc))
FROM (VALUES
 (1,'หูฟังบลูทูธไร้สาย ตัดเสียงรบกวน ANC','demo-anc-earbuds','SoundMax','หูฟัง TWS ตัดเสียงรบกวน แบตอึด 30 ชม.','Wireless ANC Bluetooth Earbuds','TWS earbuds with active noise cancelling, 30h battery.','2563eb',890,1590,4.8,2310,12000,0.95,'it_gadget'),
 (2,'พาวเวอร์แบงค์ 20000mAh ชาร์จเร็ว 22.5W','demo-powerbank-20k','VoltGo','พาวเวอร์แบงค์ความจุสูง รองรับชาร์จเร็ว','20000mAh Fast Charge Power Bank','High-capacity power bank with 22.5W fast charging.','0f766e',499,990,4.7,5400,30000,0.9,'it_gadget'),
 (3,'สมาร์ทวอทช์ วัดหัวใจ กันน้ำ IP68','demo-smartwatch-ip68','FitPulse','นาฬิกาอัจฉริยะ วัดชีพจร ออกซิเจนในเลือด','IP68 Smartwatch with Heart Rate','Smartwatch with heart-rate and SpO2 tracking.','7c3aed',1290,2490,4.6,980,4100,0.85,'it_gadget'),
 (4,'เซรั่มวิตามินซี หน้าใส 30ml','demo-vitc-serum','GlowLab','เซรั่มวิตามินซีเข้มข้น ลดจุดด่างดำ','Vitamin C Brightening Serum 30ml','Concentrated vitamin C serum for brighter skin.','db2777',329,590,4.9,8700,52000,0.93,'beauty'),
 (5,'ครีมกันแดด SPF50+ PA++++ เนื้อบางเบา','demo-sunscreen-spf50','SunCare','กันแดดเนื้อเจล ไม่เหนอะหนะ','Lightweight SPF50+ Sunscreen','Non-greasy gel sunscreen SPF50+ PA++++.','f59e0b',259,399,4.8,6100,40000,0.88,'beauty'),
 (6,'หม้อทอดไร้น้ำมัน 5 ลิตร ดิจิทัล','demo-airfryer-5l','HomeChef','หม้อทอดไร้น้ำมัน หน้าจอดิจิทัล 8 โหมด','5L Digital Air Fryer','Digital air fryer with 8 cooking presets.','dc2626',1590,3290,4.7,3300,9800,0.92,'home_appliance'),
 (7,'เครื่องดูดฝุ่นไร้สาย แรงดูด 12000Pa','demo-cordless-vacuum','CleanPro','เครื่องดูดฝุ่นไร้สาย น้ำหนักเบา','Cordless Vacuum 12000Pa','Lightweight cordless vacuum cleaner.','475569',1890,3590,4.5,1200,3500,0.8,'home_appliance'),
 (8,'เสื่อโยคะ TPE หนา 6mm กันลื่น','demo-yoga-mat','FlexFit','เสื่อโยคะกันลื่น พร้อมสายรัด','6mm Non-slip TPE Yoga Mat','Non-slip yoga mat with carry strap.','16a34a',390,690,4.8,2900,15000,0.82,'sports_fitness'),
 (9,'ดัมเบลปรับน้ำหนักได้ 20kg','demo-dumbbell-20kg','IronCore','ดัมเบลปรับน้ำหนัก ใช้งานที่บ้าน','20kg Adjustable Dumbbell Set','Adjustable dumbbells for home workouts.','1f2937',990,1490,4.6,760,2100,0.75,'sports_fitness'),
 (10,'ผ้าอ้อมสำเร็จรูป แพ้นท์ ไซส์ L 54 ชิ้น','demo-diaper-l54','BabySoft','ผ้าอ้อมนุ่ม ซึมซับดี 12 ชม.','Baby Pants Diapers L (54 pcs)','Soft diapers with 12h absorption.','0ea5e9',349,459,4.9,11000,80000,0.9,'mom_baby'),
 (11,'กระทะเคลือบหินอ่อน 28cm ไม่ติดกระทะ','demo-marble-pan-28','KitchenPro','กระทะเคลือบหินอ่อน ใช้ได้กับเตาแม่เหล็กไฟฟ้า','28cm Non-stick Marble Pan','Induction-ready non-stick marble frying pan.','92400e',459,890,4.7,4200,21000,0.86,'food_kitchen'),
 (12,'เสื้อยืดโอเวอร์ไซส์ ผ้าคอตตอน 100%','demo-oversize-tee','UrbanWear','เสื้อยืดทรงโอเวอร์ไซส์ ผ้านุ่ม','100% Cotton Oversized T-Shirt','Soft 100% cotton oversized tee.','111827',199,350,4.6,7300,60000,0.78,'fashion'),
 (13,'กล้องติดรถยนต์ 4K หน้า-หลัง','demo-dashcam-4k','DriveEye','กล้องติดรถ 4K มี WiFi ดูผ่านแอป','4K Front & Rear Dash Cam','4K dash cam with WiFi app viewing.','334155',1490,2990,4.5,1500,5200,0.84,'car_garage')
) AS t(n, th, slug, brand, th_desc, en, en_desc, color, price, orig, rating, rcount, sold, score, niche);

-- 30-day price history (a few points per product)
INSERT INTO product_prices (product_id, price, original_price, captured_at)
SELECT p.id, (p.current_price * (1 + 0.15 * sin(d)))::bigint, p.original_price, now() - (d || ' days')::interval
FROM products p, generate_series(0, 30, 5) d
WHERE p.external_id LIKE 'demo-%';

-- Web tracking links so "Buy" buttons point at the redirect server
INSERT INTO affiliate_links (short_id, product_id, channel, full_url)
SELECT 'demo' || p.id, p.id, 'web', 'https://shopee.co.th/search?keyword=' || p.brand
FROM products p WHERE p.external_id LIKE 'demo-%';
COMMIT;
