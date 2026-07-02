export function Navbar() {
  return (
    <nav className="fixed top-0 left-0 right-0 z-50 border-b border-[var(--border)] bg-[var(--background)]/80 backdrop-blur-md">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <span className="text-lg font-bold tracking-tight text-[var(--foreground)]">
          clicked<span className="text-[var(--accent)]">.</span>
        </span>
        <div className="hidden items-center gap-8 text-sm text-[var(--foreground)]/60 sm:flex">
          <a href="#features" className="hover:text-[var(--foreground)] transition-colors">
            Features
          </a>
          <a href="#how-it-works" className="hover:text-[var(--foreground)] transition-colors">
            How it works
          </a>
          <a href="#tech" className="hover:text-[var(--foreground)] transition-colors">
            Tech
          </a>
        </div>
        <a
          href="/app"
          className="rounded-full bg-[var(--accent)] px-5 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
        >
          Launch App
        </a>
      </div>
    </nav>
  );
}
