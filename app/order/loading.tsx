export default function OrderLoading() {
  return (
    <div className="p-4 md:p-6 w-full animate-pulse">
      <div className="h-8 bg-gray-200 dark:bg-gray-800 rounded w-1/3 mb-6"></div>
      
      {/* List items skeleton */}
      <div className="flex flex-col gap-3">
        {[1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="h-16 bg-gray-200 dark:bg-gray-800 rounded-lg w-full"></div>
        ))}
      </div>
    </div>
  );
}
