export default function WatchlistLoading() {
  return (
    <div className="p-4 md:p-6 w-full animate-pulse h-full bg-gray-50 dark:bg-[#0B0E14]">
      {/* Top Search bar / tabs skeleton */}
      <div className="h-12 bg-gray-200 dark:bg-gray-800 rounded-lg w-full mb-4"></div>
      
      {/* Tab bar skeleton */}
      <div className="flex gap-2 mb-6 overflow-x-hidden">
        {[1, 2, 3, 4, 5, 6].map((i) => (
          <div key={i} className="h-8 bg-gray-200 dark:bg-gray-800 rounded-full w-20 flex-shrink-0"></div>
        ))}
      </div>

      {/* List items skeleton */}
      <div className="flex flex-col gap-1">
        {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
          <div key={i} className="h-16 bg-gray-200 dark:bg-gray-800 rounded-lg w-full mb-2"></div>
        ))}
      </div>
    </div>
  );
}
