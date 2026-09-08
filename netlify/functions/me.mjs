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

  const cookies = cookieHeader
    .split(";")
    .map((cookie) => cookie.trim());

  for (const cookie of cookies) {
    const separator = cookie.indexOf("=");

    if (separator === -1) continue;

    const key = cookie.slice(0, separator);
    const value = cookie.slice(separator + 1);

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
        apikey: SUPABASE_SECRET_KEY,
        "content-type": "application/json",
        ...(options.headers ?? {}),
      },
    }
  );

  const text = await response.text();

  if (!response.ok) {
    console.error(
      "Supabase error:",
      response.status,
      text
    );

    throw new Error("Erreur de base de données.");
  }

  return text ? JSON.parse(text) : null;
}

async function findSession(tokenHash) {
  const params = new URLSearchParams({
    token_hash: `eq.${tokenHash}`,
    select: "user_id,expires_at",
    limit: "1",
  });

  const rows = await supabase(
    `user_sessions?${params.toString()}`
  );

  return rows?.[0] ?? null;
}

async function getUser(userId) {
  const params = new URLSearchParams({
    id: `eq.${userId}`,
    select:
      "id,display_name,avatar_key,country_code,unit_id",
    limit: "1",
  });

  const rows = await supabase(
    `users?${params.toString()}`
  );

  return rows?.[0] ?? null;
}

async function getUnit(unitId) {
  if (!unitId) return null;

  const params = new URLSearchParams({
    id: `eq.${unitId}`,
    select: "id,name,city,country",
    limit: "1",
  });

  const rows = await supabase(
    `units?${params.toString()}`
  );

  return rows?.[0] ?? null;
}

async function updateSessionActivity(tokenHash) {
  await supabase(
    `user_sessions?token_hash=eq.${tokenHash}`,
    {
      method: "PATCH",

      headers: {
        Prefer: "return=minimal",
      },

      body: JSON.stringify({
        last_used_at: new Date().toISOString(),
      }),
    }
  );
}

async function deleteSession(tokenHash) {
  await supabase(
    `user_sessions?token_hash=eq.${tokenHash}`,
    {
      method: "DELETE",
      headers: {
        Prefer: "return=minimal",
      },
    }
  );
}

function expiredCookie() {
  return (
    `${COOKIE_NAME}=; ` +
    `HttpOnly; Secure; SameSite=Lax; ` +
    `Path=/; Max-Age=0`
  );
}

export default async (req) => {
  if (req.method !== "GET") {
    return json(
      { error: "Méthode non autorisée." },
      405
    );
  }

  if (
    !SUPABASE_URL ||
    !SUPABASE_SECRET_KEY
  ) {
    return json(
      {
        error:
          "Configuration serveur incomplète.",
      },
      500
    );
  }

  try {
    const sessionToken =
      getCookie(req, COOKIE_NAME);

    if (!sessionToken) {
      return json(
        {
          ok: false,
          authenticated: false,
        },
        401
      );
    }

    const tokenHash =
      hashSessionToken(sessionToken);

    const session =
      await findSession(tokenHash);

    if (!session) {
      return json(
        {
          ok: false,
          authenticated: false,
        },
        401,
        {
          "set-cookie": expiredCookie(),
        }
      );
    }

    if (
      new Date(session.expires_at).getTime() <=
      Date.now()
    ) {
      await deleteSession(tokenHash);

      return json(
        {
          ok: false,
          authenticated: false,
        },
        401,
        {
          "set-cookie": expiredCookie(),
        }
      );
    }

    const user =
      await getUser(session.user_id);

    if (!user) {
      return json(
        {
          ok: false,
          authenticated: false,
        },
        401,
        {
          "set-cookie": expiredCookie(),
        }
      );
    }

    const unit =
      await getUnit(user.unit_id);

    await updateSessionActivity(tokenHash);

    return json({
      ok: true,
      authenticated: true,

      user: {
        id: user.id,
        displayName: user.display_name,
        avatar: user.avatar_key,
        countryCode: user.country_code,

        unit: unit
          ? {
              id: unit.id,
              name: unit.name,
              city: unit.city,
              country: unit.country,
            }
          : null,
      },
    });
  } catch (error) {
    console.error("Me error:", error);

    return json(
      {
        error:
          "Impossible de récupérer le profil.",
      },
      500
    );
  }
};

export const config = {
  path: "/api/me",
};
