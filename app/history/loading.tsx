export default function HistoryLoading() {
  return (
    <div className="p-4 md:p-6 w-full animate-pulse h-full bg-gray-50 dark:bg-[#0B0E14]">
      {/* Tab bar skeleton */}
      <div className="flex gap-2 mb-6 w-full">
        <div className="h-10 bg-gray-200 dark:bg-gray-800 rounded-lg w-1/2"></div>
        <div className="h-10 bg-gray-200 dark:bg-gray-800 rounded-lg w-1/2"></div>
      </div>
      
      {/* Filters skeleton */}
      <div className="flex gap-4 mb-6">
        <div className="h-8 bg-gray-200 dark:bg-gray-800 rounded-full w-1/3"></div>
        <div className="h-8 bg-gray-200 dark:bg-gray-800 rounded-full w-1/3"></div>
      </div>

      {/* List items skeleton */}
      <div className="flex flex-col gap-3">
        {[1, 2, 3, 4, 5, 6, 7].map((i) => (
          <div key={i} className="h-20 bg-gray-200 dark:bg-gray-800 rounded-lg w-full"></div>
        ))}
      </div>
    </div>
  );
}
