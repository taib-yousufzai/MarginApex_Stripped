export default function Loading() {
  return (
    <div className="desktop-layout">
      <main className="main-viewport">
        <div className="mobile-app" style={{ background: '#f5f7fb' }}>
          <div className="app-header p-4 border-b border-gray-100 dark:border-gray-800">
            <div className="h-8 bm-skeleton w-24"></div>
          </div>
          <div className="p-4 flex flex-col gap-6">
            <div className="h-40 bm-skeleton w-full rounded-2xl"></div>
            <div className="h-6 bm-skeleton w-32"></div>
            <div className="flex flex-col gap-3">
              {[1, 2, 3].map(i => (
                <div key={i} className="h-16 bm-skeleton w-full rounded-xl"></div>
              ))}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
