import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Doorstep · Your deliveries, together",
  description: "A shared home for your orders, delivery updates, and calendar.",
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
