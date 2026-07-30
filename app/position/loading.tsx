export default function Loading() {
  return (
    <div className="desktop-layout">
      <main className="main-viewport">
        <div className="mobile-app" style={{ background: '#f5f7fb' }}>
          <div className="app-header p-4">
            <div className="h-8 bm-skeleton w-32"></div>
          </div>
          <div className="p-4 flex flex-col gap-4">
            <div className="flex justify-between items-center bg-gray-50 dark:bg-gray-800 p-4 rounded-xl">
              <div className="h-10 bm-skeleton w-24"></div>
              <div className="h-10 bm-skeleton w-24"></div>
            </div>
            {[1, 2, 3].map(i => (
              <div key={i} className="h-32 bm-skeleton w-full rounded-xl"></div>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}
