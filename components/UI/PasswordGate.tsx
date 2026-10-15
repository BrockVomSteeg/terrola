"use client";

import { useState, useRef, KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { BRAND } from "@/lib/brand";

export default function PasswordGate() {
  const [value, setValue] = useState("");
  const [shaking, setShaking] = useState(false);
  const [borderError, setBorderError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  // Shake, say what went wrong, and put the cursor back in the field.
  function fail(text: string) {
    setMessage(text);
    setBorderError(true);
    setShaking(true);
    setTimeout(() => setShaking(false), 500);
    setTimeout(() => setBorderError(false), 1200);
    inputRef.current?.focus();
  }

  async function submit() {
    if (loading || !value) return;
    setLoading(true);
    setMessage("");

    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: value }),
      });

      if (res.ok) {
        // Blur before nav: prevents phantom caret on macOS Chrome when the
        // focused input unmounts during route transition.
        inputRef.current?.blur();
        await new Promise((resolve) => requestAnimationFrame(resolve));
        router.push("/map");
      } else if (res.status === 401) {
        setValue("");
        fail("Wrong password.");
      } else if (res.status === 429) {
        fail("Too many tries. Wait a few minutes, then try again.");
      } else {
        fail("The site can't check the password right now. Try again later.");
      }
    } catch {
      fail("The site can't check the password right now. Try again later.");
    } finally {
      setLoading(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") submit();
  }

  return (
    <div
      style={{ background: "#F2E8D9" }}
      className="fixed inset-0 flex flex-col items-center justify-center"
    >
      <div className="flex flex-col items-center gap-6">
        {/* Decorative symbol above */}
        <span
          style={{ color: "#C17F5A", fontSize: "20px", lineHeight: 1 }}
          aria-hidden="true"
        >
          ✦
        </span>

        {/* Name and instruction */}
        <div className="flex flex-col items-center gap-2 text-center">
          <h1
            style={{
              fontFamily: "var(--font-cormorant), serif",
              fontSize: "24px",
              fontWeight: 500,
              color: "#6B4F3A",
              margin: 0,
            }}
          >
            {BRAND.name}
          </h1>
          <label
            htmlFor="password"
            style={{
              fontFamily: "var(--font-cormorant), serif",
              fontStyle: "italic",
              fontSize: "16px",
              color: "#6B4F3A",
            }}
          >
            Enter the password to open the map.
          </label>
        </div>

        {/* Password input */}
        <div
          className={`relative ${shaking ? "animate-shake" : ""}`}
          style={{ maxWidth: "260px", width: "260px" }}
        >
          <input
            id="password"
            ref={inputRef}
            aria-invalid={borderError}
            aria-describedby="password-message"
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="•••••••••"
            autoComplete="current-password"
            style={{
              fontFamily: "var(--font-cormorant), serif",
              fontStyle: "italic",
              fontSize: "20px",
              color: "#6B4F3A",
              background: "transparent",
              border: "none",
              borderBottom: `1.5px solid ${borderError ? "#C23A4B" : "rgba(107,79,58,0.75)"}`,
              outline: "none",
              width: "100%",
              padding: "8px 0",
              textAlign: "center",
              letterSpacing: "2px",
              transition: "border-color 0.2s",
            }}
          />
        </div>

        <p
          id="password-message"
          role="status"
          style={{
            fontFamily: "var(--font-quicksand), sans-serif",
            fontSize: "13px",
            color: "#6B4F3A",
            margin: 0,
            minHeight: "18px",
            maxWidth: "260px",
            textAlign: "center",
          }}
        >
          {message}
        </p>

        {/* Submit symbol below */}
        <button
          onClick={submit}
          disabled={loading}
          aria-label="Submit password"
          style={{
            color: "#8F4F2B",
            fontSize: "18px",
            background: "none",
            border: "none",
            cursor: "pointer",
            opacity: loading ? 0.4 : 1,
            transition: "opacity 0.15s",
            lineHeight: 1,
          }}
        >
          ✦
        </button>
      </div>
    </div>
  );
}
