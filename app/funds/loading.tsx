export default function FundsLoading() {
  return (
    <div className="p-4 md:p-6 w-full animate-pulse">
      {/* Total Balance Skeleton */}
      <div className="h-32 bg-gray-200 dark:bg-gray-800 rounded-xl mb-6 flex flex-col justify-center items-center gap-2">
        <div className="h-4 bg-gray-300 dark:bg-gray-700 rounded w-1/4"></div>
        <div className="h-8 bg-gray-300 dark:bg-gray-700 rounded w-1/2"></div>
      </div>
      
      {/* Buttons Skeleton */}
      <div className="flex gap-4 mb-8">
        <div className="h-12 bg-gray-200 dark:bg-gray-800 rounded-lg flex-1"></div>
        <div className="h-12 bg-gray-200 dark:bg-gray-800 rounded-lg flex-1"></div>
      </div>

      {/* History List Skeleton */}
      <div className="flex flex-col gap-3">
        <div className="h-6 bg-gray-200 dark:bg-gray-800 rounded w-1/4 mb-2"></div>
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-16 bg-gray-200 dark:bg-gray-800 rounded-lg w-full"></div>
        ))}
      </div>
    </div>
  );
}
