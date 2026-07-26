export default function Loading() {
  return (
    <div className="flex items-center justify-center min-h-screen bg-white dark:bg-[#121212]">
      <div className="flex flex-col items-center gap-4">
        <i className="fa-solid fa-circle-notch fa-spin text-4xl text-blue-500"></i>
        <p className="text-gray-500 dark:text-gray-400 font-medium">Loading...</p>
      </div>
    </div>
  );
}
