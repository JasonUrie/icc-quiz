import { createHash } from "node:crypto";

const SUPABASE_URL =
  process.env.ICC_QUIZ_SUPABASE_URL;

const SUPABASE_SECRET_KEY =
  process.env.ICC_QUIZ_SUPABASE_SECRET_KEY;

const COOKIE_NAME = "__Host-icc_quiz_session";

const json = (body, status = 200, extraHeaders = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });

function getCookie(req, name) {
  const cookieHeader =
    req.headers.get("cookie") || "";

  for (const cookie of cookieHeader.split(";")) {
    const trimmed = cookie.trim();
    const separator = trimmed.indexOf("=");

    if (separator === -1) continue;

    const key =
      trimmed.slice(0, separator);

    const value =
      trimmed.slice(separator + 1);

    if (key === name) {
      return value;
    }
  }

  return null;
}

function hashSessionToken(token) {
  return createHash("sha256")
    .update(token)
    .digest("hex");
}

async function supabase(path, options = {}) {
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/${path}`,
    {
      ...options,
      headers: {
        apikey:
          SUPABASE_SECRET_KEY,

        "content-type":
          "application/json",

        ...(options.headers ?? {}),
      },
    }
  );

  const text =
    await response.text();

  if (!response.ok) {
    console.error(
      "Supabase error:",
      response.status,
      text
    );

    throw new Error(
      "Erreur de base de données."
    );
  }

  return text
    ? JSON.parse(text)
    : null;
}

async function deleteSession(tokenHash) {
  const params =
    new URLSearchParams({
      token_hash:
        `eq.${tokenHash}`,
    });

  await supabase(
    `user_sessions?${params.toString()}`,
    {
      method: "DELETE",

      headers: {
        Prefer:
          "return=minimal",
      },
    }
  );
}

function clearCookie() {
  return (
    `${COOKIE_NAME}=; ` +
    `HttpOnly; Secure; SameSite=Lax; ` +
    `Path=/; Max-Age=0`
  );
}

export default async (req) => {
  if (req.method !== "POST") {
    return json(
      {
        error:
          "Méthode non autorisée.",
      },
      405
    );
  }

  try {
    const token =
      getCookie(
        req,
        COOKIE_NAME
      );

    if (token) {
      const tokenHash =
        hashSessionToken(token);

      await deleteSession(
        tokenHash
      );
    }

    return json(
      {
        ok: true,
      },
      200,
      {
        "set-cookie":
          clearCookie(),
      }
    );
  } catch (error) {
    console.error(
      "Logout error:",
      error
    );

    return json(
      {
        error:
          "Impossible de se déconnecter.",
      },
      500
    );
  }
};

export const config = {
  path: "/api/logout",
};
