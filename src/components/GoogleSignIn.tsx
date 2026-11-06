// In-page Google sign-in: One Tap prompt first; if the browser/Google suppresses it
// (dismissed, cool-down, blocked), a "Sign in with Google" button rendered in place.
// Both use Google Identity Services, so the user never leaves the page.
import { useEffect, useRef, useState } from "react";
import { authClient, oneTap } from "~/lib/auth-client";

export function GoogleSignIn({ onDone, prompt = true }: { onDone: () => void; prompt?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [showRedirect, setShowRedirect] = useState(!oneTap);
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    const tap = oneTap;
    if (!tap) return;
    let alive = true;
    const fetchOptions = {
      onSuccess: () => alive && done.current(),
      onError: (ctx: { error: { message?: string } }) => alive && setError(ctx.error.message ?? "Đăng nhập thất bại"),
    };
    const renderButton = () => {
      if (!alive || !box.current) return;
      tap({
        fetchOptions,
        button: { container: box.current, config: { type: "standard", theme: "filled_blue", text: "continue_with", shape: "pill", width: 280 } },
      }).catch(() => alive && setShowRedirect(true));
    };
    if (prompt) {
      tap({ fetchOptions, cancelOnTapOutside: false, onPromptNotification: renderButton }).catch(renderButton);
    } else renderButton();
    return () => {
      alive = false;
    };
  }, [prompt]);

  return (
    <div className="gsi">
      <div ref={box} />
      {showRedirect && (
        <button
          className="btn btn--primary btn--sm"
         
          onClick={() => authClient.signIn.social({ provider: "google", callbackURL: location.pathname })}
        >
          Tiếp tục với Google
        </button>
      )}
      {error && <span className="ai__err">{error}</span>}
    </div>
  );
}
