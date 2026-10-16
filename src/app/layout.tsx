/* The brand sites and the dashboard arrive in later phases; the backend is
   what runs today, so this is deliberately bare. */
export const metadata = { title: "Petrosil Platform" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
