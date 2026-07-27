export default function Loading() {
  return (
    <div className="flex flex-col gap-4 p-4 w-full h-screen bg-white dark:bg-[#121212]">
      <div className="h-12 bm-skeleton w-48 mb-6"></div>
      {[1, 2, 3, 4, 5].map(i => (
        <div key={i} className="flex gap-4">
          <div className="h-16 bm-skeleton flex-1"></div>
        </div>
      ))}
    </div>
  );
}
