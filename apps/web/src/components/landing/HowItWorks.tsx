const STEPS = [
  {
    step: '01',
    title: 'Connect your wallet',
    description:
      'Sign in with your Freighter wallet. No account creation — your Stellar address is your identity.',
  },
  {
    step: '02',
    title: 'Start or join a conversation',
    description:
      'Open a DM with any wallet address or join a group. Conversations are end-to-end linked to on-chain identities.',
  },
  {
    step: '03',
    title: 'Send tokens inside the chat',
    description:
      'Type a transfer command or tap the payment button. Tokens move on-chain; the receipt appears inline in the thread.',
  },
  {
    step: '04',
    title: 'Fund ideas together',
    description:
      'Create a proposal, let the group vote, and release treasury funds — all without leaving the conversation.',
  },
];

export function HowItWorks() {
  return (
    <section id="how-it-works" className="border-t border-[var(--border)] bg-[var(--card)]">
      <div className="mx-auto max-w-6xl px-6 py-32">
        <div className="mb-16 text-center">
          <h2 className="text-3xl font-bold tracking-tight text-[var(--foreground)] sm:text-4xl">
            How it works
          </h2>
          <p className="mt-4 text-[var(--foreground)]/50">
            From wallet connect to on-chain governance in four steps.
          </p>
        </div>

        <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((s, i) => (
            <div key={s.step} className="flex flex-col gap-4">
              <div className="flex items-center gap-3">
                <span className="font-mono text-sm font-bold text-[var(--accent)]">{s.step}</span>
                {i < STEPS.length - 1 && (
                  <div className="hidden h-px flex-1 bg-[var(--border)] lg:block" />
                )}
              </div>
              <h3 className="text-base font-semibold text-[var(--foreground)]">{s.title}</h3>
              <p className="text-sm leading-relaxed text-[var(--foreground)]/50">{s.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
