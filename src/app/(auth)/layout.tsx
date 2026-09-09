export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <main className="flex flex-1 min-h-screen items-center justify-center bg-background p-4">
      {children}
    </main>
  );
}
