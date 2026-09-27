import { useEffect } from "react";

/** Keeps the browser tab title in step with what is on screen and in which language. */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = title;
  }, [title]);
}
