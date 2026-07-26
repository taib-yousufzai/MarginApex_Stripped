export default function DashboardLoading() {
  return (
    <div className="p-4 md:p-6 w-full animate-pulse">
      {/* Header Skeleton */}
      <div className="flex justify-between items-center mb-6">
        <div className="h-8 bg-gray-200 dark:bg-gray-800 rounded w-1/4"></div>
        <div className="h-10 w-10 bg-gray-200 dark:bg-gray-800 rounded-full"></div>
      </div>
      
      {/* Cards Skeleton */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="h-24 bg-gray-200 dark:bg-gray-800 rounded-xl"></div>
        ))}
      </div>

      {/* Main Content Skeleton */}
      <div className="h-64 bg-gray-200 dark:bg-gray-800 rounded-xl w-full"></div>
    </div>
  );
}
