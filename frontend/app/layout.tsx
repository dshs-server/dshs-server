import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PC 대여 포털",
  description: "학교 전산실 GPU 데스크톱 대여 시스템",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ko">
      <head>
        <link
          rel="stylesheet"
          as="style"
          href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css"
        />
        <meta name="theme-color" content="#0b1031" />
      </head>
      <body>{children}</body>
    </html>
  );
}
