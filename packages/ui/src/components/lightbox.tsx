import { X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { useState, type ReactNode } from "react";
import { cn } from "../lib/cn";

/**
 * The picture over the app. Clicking the dimmed page, Close, or Escape dismisses it.
 */
export function ImageLightbox({
  src,
  alt,
  open,
  onOpenChange,
}: {
  src: string;
  alt: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[70] bg-overlay animate-ui-fade-in" />
        <DialogPrimitive.Content
          data-submit-scope=""
          className="fixed inset-0 z-[70] flex items-center justify-center p-4 focus:outline-none sm:p-8"
          onClick={() => onOpenChange(false)}
        >
          <DialogPrimitive.Title className="sr-only">{alt}</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            Enlarged image. Close to return.
          </DialogPrimitive.Description>
          <img
            src={src}
            alt={alt}
            className="max-h-[calc(100dvh-4rem)] max-w-[calc(100vw-2rem)] rounded-lg object-contain shadow-lg"
            onClick={(event) => event.stopPropagation()}
          />
          <DialogPrimitive.Close
            aria-label="Close"
            className="absolute right-3 top-3 z-10 grid size-8 place-items-center rounded-md bg-surface text-foreground shadow-lg hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
            onClick={(event) => event.stopPropagation()}
          >
            <X aria-hidden className="size-4" />
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/**
 * An image that opens over the app when clicked. Chat screenshots and attachments use this so a
 * click stays on the page.
 */
export function LightboxImage({
  src,
  alt,
  className,
  imgClassName,
  loading = "lazy",
  children,
}: {
  src: string;
  /** Accessible name of the picture, also the lightbox title. */
  alt: string;
  className?: string;
  imgClassName?: string;
  loading?: "eager" | "lazy";
  /** Trigger content. Omit it to show the image itself. */
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        aria-label={`View ${alt}`}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        className={cn(
          "inline-flex max-w-full cursor-zoom-in rounded-md p-0 text-left focus-visible:outline-2 focus-visible:outline-ring",
          className,
        )}
      >
        {children ?? <img src={src} alt="" loading={loading} className={imgClassName} />}
      </button>
      <ImageLightbox src={src} alt={alt} open={open} onOpenChange={setOpen} />
    </>
  );
}
