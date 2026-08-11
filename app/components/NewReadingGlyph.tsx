export function NewReadingGlyph({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M6.5 4.5h8.25a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H6.5a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2Z"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path d="M10.6 9v6M7.6 12h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path
        d="M18.25 2.5c.38 1.5 1 2.12 2.5 2.5-1.5.38-2.12 1-2.5 2.5-.38-1.5-1-2.12-2.5-2.5 1.5-.38 2.12-1 2.5-2.5Z"
        fill="currentColor"
      />
    </svg>
  );
}
