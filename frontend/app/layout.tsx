import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "PC 대여 포털",
  description: "학교 전산실 컴퓨터 대여 시스템",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ko">
      <body
        style={{
          margin: 0,
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
          background: "#f5f5f5",
          minHeight: "100vh",
        }}
      >
        {children}
      </body>
    </html>
  );
}
