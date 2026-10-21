import "./globals.css";

export const metadata = {
  title: "Petrosil Platform",
  description: "One admin for the whole estate.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
