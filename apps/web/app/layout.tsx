import type { Metadata } from 'next';
import './globals.css';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';

export const metadata: Metadata = {
  title: 'Fourth Down — Local Fantasy Draft Assistant',
  description: 'A private, local decision companion with explainable recommendations and read-only ESPN observation.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body><TooltipProvider>{children}<Toaster richColors position="top-center" /></TooltipProvider></body>
    </html>
  );
}
