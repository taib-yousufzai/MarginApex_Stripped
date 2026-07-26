export default function PositionLoading() {
  return (
    <div className="p-4 md:p-6 w-full animate-pulse">
      <div className="h-8 bg-gray-200 dark:bg-gray-800 rounded w-1/3 mb-6"></div>
      
      {/* Summary boxes skeleton */}
      <div className="grid grid-cols-2 gap-4 mb-6">
        <div className="h-20 bg-gray-200 dark:bg-gray-800 rounded-lg"></div>
        <div className="h-20 bg-gray-200 dark:bg-gray-800 rounded-lg"></div>
      </div>

      {/* Position list skeleton */}
      <div className="flex flex-col gap-3">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="h-24 bg-gray-200 dark:bg-gray-800 rounded-lg w-full"></div>
        ))}
      </div>
    </div>
  );
}
