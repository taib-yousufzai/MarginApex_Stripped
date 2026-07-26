export default function OptionChainLoading() {
  return (
    <div className="p-4 md:p-6 w-full animate-pulse h-full bg-gray-50 dark:bg-[#0B0E14]">
      {/* Top Header skeleton */}
      <div className="flex justify-between items-center mb-6 w-full">
        <div className="h-8 bg-gray-200 dark:bg-gray-800 rounded w-1/3"></div>
        <div className="h-8 bg-gray-200 dark:bg-gray-800 rounded w-1/4"></div>
      </div>
      
      {/* Settings / Filters skeleton */}
      <div className="flex gap-4 mb-6">
        <div className="h-10 bg-gray-200 dark:bg-gray-800 rounded-lg w-full"></div>
      </div>

      {/* Option Chain Grid skeleton */}
      <div className="flex flex-col gap-2">
        {/* Table header */}
        <div className="h-10 bg-gray-300 dark:bg-gray-700 rounded-t-lg w-full mb-1"></div>
        
        {/* Table rows */}
        {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => (
          <div key={i} className="flex gap-1 w-full">
            <div className="h-12 bg-gray-200 dark:bg-gray-800 rounded-l w-2/5"></div>
            <div className="h-12 bg-gray-300 dark:bg-gray-700 rounded-none w-1/5"></div>
            <div className="h-12 bg-gray-200 dark:bg-gray-800 rounded-r w-2/5"></div>
          </div>
        ))}
      </div>
    </div>
  );
}
