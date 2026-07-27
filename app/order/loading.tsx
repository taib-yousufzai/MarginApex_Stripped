export default function Loading() {
  return (
    <div className="desktop-layout">
      <main className="main-viewport">
        <div className="mobile-app">
          <div className="app-header p-4">
            <div className="h-8 bm-skeleton w-24"></div>
          </div>
          <div className="p-4 flex flex-col gap-4">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="h-24 bm-skeleton w-full rounded-xl"></div>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}
