import { LoginForm } from "./login-form";

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
        <div className="mb-6 flex items-center gap-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-600 font-bold text-white">A</span>
          <div>
            <p className="font-semibold text-slate-900">Affiliate AI</p>
            <p className="text-xs text-slate-500">ระบบหลังบ้าน</p>
          </div>
        </div>
        <LoginForm />
      </div>
    </main>
  );
}
