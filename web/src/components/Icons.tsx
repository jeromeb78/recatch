// Stroke icons (24×24, currentColor).
import type { ReactNode } from "react";
type P = { size?: number };

const svg = (size: number, children: ReactNode, width = 2) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={width}
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

export const HomeIcon = ({ size = 22 }: P) => svg(size, <path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z" />);
export const ReceiptIcon = ({ size = 22 }: P) => svg(size, <><path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" /><path d="M9 8h6M9 12h6" /></>);
export const CameraIcon = ({ size = 26 }: P) => svg(size, <><path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></>);
export const CheckIcon = ({ size = 22 }: P) => svg(size, <path d="M20 6L9 17l-5-5" />, 2.4);
export const SettingsIcon = ({ size = 22 }: P) => svg(size, <><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1L7 17M17 7l2.1-2.1" /></>);
export const SearchIcon = ({ size = 20 }: P) => svg(size, <><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></>);
export const ChevronRight = ({ size = 16 }: P) => svg(size, <path d="M9 6l6 6-6 6" />, 2.2);
export const ChevronLeft = ({ size = 18 }: P) => svg(size, <path d="M15 6l-6 6 6 6" />, 2.2);
export const CloseIcon = ({ size = 18 }: P) => svg(size, <path d="M6 6l12 12M18 6L6 18" />, 2.2);
export const AlertIcon = ({ size = 20 }: P) => svg(size, <><path d="M12 3l10 18H2z" /><path d="M12 10v5M12 18v.5" /></>);
export const DownloadIcon = ({ size = 18 }: P) => svg(size, <><path d="M12 3v12M7 10l5 5 5-5" /><path d="M4 19h16" /></>);
export const FileIcon = ({ size = 28 }: P) => svg(size, <><path d="M7 3h7l5 5v13H7z" /><path d="M14 3v5h5" /></>, 1.6);
