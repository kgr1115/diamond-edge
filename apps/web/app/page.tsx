export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-background px-4">
      <div className="text-center">
        <h1 className="text-4xl font-bold tracking-tight text-foreground sm:text-6xl">
          Diamond Edge
        </h1>
        <p className="mt-4 text-lg text-muted-foreground">
          MLB picks powered by data. Coming soon.
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          Statistically-grounded, AI-explained picks for serious bettors.
        </p>
      </div>
    </main>
  );
}
