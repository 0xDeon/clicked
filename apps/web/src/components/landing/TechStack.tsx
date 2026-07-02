const STACK = [
  { label: 'Next.js 16', category: 'Frontend' },
  { label: 'TailwindCSS v4', category: 'Frontend' },
  { label: 'Express 5', category: 'Backend' },
  { label: 'Socket.IO', category: 'Backend' },
  { label: 'PostgreSQL', category: 'Backend' },
  { label: 'Redis', category: 'Backend' },
  { label: 'Soroban', category: 'Blockchain' },
  { label: 'Stellar SDK', category: 'Blockchain' },
  { label: 'XMTP', category: 'Messaging' },
  { label: 'FastAPI', category: 'AI' },
  { label: 'Weaviate', category: 'AI' },
  { label: 'Turborepo', category: 'Infra' },
];

const CATEGORY_COLORS: Record<string, string> = {
  Frontend: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  Backend: 'bg-green-500/10 text-green-400 border-green-500/20',
  Blockchain: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
  Messaging: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
  AI: 'bg-pink-500/10 text-pink-400 border-pink-500/20',
  Infra: 'bg-orange-500/10 text-orange-400 border-orange-500/20',
};

export function TechStack() {
  return (
    <section id="tech" className="mx-auto max-w-6xl px-6 py-32">
      <div className="mb-16 text-center">
        <h2 className="text-3xl font-bold tracking-tight text-[var(--foreground)] sm:text-4xl">
          Built on proven technology
        </h2>
        <p className="mt-4 text-[var(--foreground)]/50">
          A modern monorepo combining Web2 developer experience with Web3 ownership.
        </p>
      </div>

      <div className="flex flex-wrap justify-center gap-3">
        {STACK.map((item) => (
          <span
            key={item.label}
            className={`rounded-full border px-4 py-2 text-sm font-medium ${CATEGORY_COLORS[item.category]}`}
          >
            {item.label}
          </span>
        ))}
      </div>
    </section>
  );
}
