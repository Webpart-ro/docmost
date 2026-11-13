import React from "react";

// Webpart mark, same artwork as webpart.ro/app/icon.svg and the Vikunja icon rail.
export function WebpartMark(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true" focusable="false" {...props}>
      <rect width="64" height="64" rx="15" fill="#10312b" />
      <path
        fill="#d63e14"
        d="M8 25h7.7l6 12.6L28.2 25h8.6l6.4 12.6L48.8 25H56l-8 18.9h-9.5l-6-11.5-6 11.5H17L8 25Z"
      />
      <path fill="#fff" d="M50 16h6l-2.9 7h-6l2.9-7Z" />
    </svg>
  );
}
