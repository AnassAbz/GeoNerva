export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-6 px-4 py-16">
      <h1 className="text-4xl font-semibold tracking-tight">GeoNerva</h1>
      <p className="text-xl text-slate-300">Understand what’s changing around you.</p>
      <p className="text-slate-400">
        Open-source, explainable natural-hazard intelligence for the places you care about.
      </p>
      <p
        role="status"
        className="rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-amber-200"
      >
        GeoNerva is under active development. No live hazard data is shown yet.
      </p>
    </main>
  );
}
