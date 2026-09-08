import { createHash, createHmac, randomBytes } from "node:crypto";

const SUPABASE_URL = process.env.ICC_QUIZ_SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.ICC_QUIZ_SUPABASE_SECRET_KEY;
const PHONE_HASH_SECRET = process.env.ICC_QUIZ_PHONE_HASH_SECRET;

const SESSION_DAYS = 90;

const json = (body, status = 200, extraHeaders = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });

function normalizeName(value) {
  const name = String(value ?? "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();

  if (!name) return null;

  if (name.length > 30) {
    throw new Error("Le nom ne peut pas dépasser 30 caractères.");
  }

  if (!/^[\p{L}\p{M}\p{N} .'-]+$/u.test(name)) {
    throw new Error("Le nom contient des caractères non autorisés.");
  }

  const simplified = name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();

  const blockedWords = [
    "fuck",
    "shit",
    "pute",
    "salope",
    "connard",
    "fdp"
  ];

  if (blockedWords.some((word) => simplified.includes(word))) {
    throw new Error("Ce nom ne peut pas être utilisé.");
  }

  return name;
}

function normalizePhone(callingCode, phone) {
  const code = String(callingCode ?? "")
    .trim()
    .replace(/[^\d+]/g, "");

  if (!/^\+\d{1,4}$/.test(code)) {
    throw new Error("Préfixe pays invalide.");
  }

  let raw = String(phone ?? "")
    .trim()
    .replace(/[\s().-]/g, "");

  if (raw.startsWith("00")) {
    raw = `+${raw.slice(2)}`;
  }

  let normalized;

  if (raw.startsWith("+")) {
    normalized = `+${raw.slice(1).replace(/\D/g, "")}`;
  } else {
    const localDigits = raw
      .replace(/\D/g, "")
      .replace(/^0+/, "");

    normalized = `${code}${localDigits}`;
  }

  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) {
    throw new Error("Numéro de téléphone invalide.");
  }

  return normalized;
}

function phoneFingerprint(normalizedPhone) {
  return createHmac("sha256", PHONE_HASH_SECRET)
    .update(normalizedPhone)
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

async function findUser(phoneHash) {
  const params = new URLSearchParams({
    phone_hash: `eq.${phoneHash}`,
    select:
      "id,display_name,country_code,avatar_key,unit_id",
    limit: "1",
  });

  const rows = await supabase(
    `users?${params.toString()}`
  );

  return rows?.[0] ?? null;
}

async function getBrusselsUnitId() {
  const params = new URLSearchParams({
    name: "eq.ICC Bruxelles",
    select: "id",
    limit: "1",
  });

  const rows = await supabase(
    `units?${params.toString()}`
  );

  return rows?.[0]?.id ?? null;
}

async function createUser({
  displayName,
  phoneHash,
  callingCode,
}) {
  const unitId = await getBrusselsUnitId();

  if (!unitId) {
    throw new Error(
      "L'unité ICC Bruxelles est introuvable."
    );
  }

  const rows = await supabase("users", {
    method: "POST",

    headers: {
      Prefer: "return=representation",
    },

    body: JSON.stringify({
      display_name: displayName,
      phone_hash: phoneHash,
      country_code: callingCode,
      avatar_key: "bible",
      unit_id: unitId,
    }),
  });

  return rows?.[0];
}

async function createSession(userId) {
  const token = randomBytes(32).toString("base64url");

  const tokenHash = createHash("sha256")
    .update(token)
    .digest("hex");

  const expiresAt = new Date(
    Date.now() +
      SESSION_DAYS *
        24 *
        60 *
        60 *
        1000
  );

  await supabase("user_sessions", {
    method: "POST",

    headers: {
      Prefer: "return=minimal",
    },

    body: JSON.stringify({
      user_id: userId,
      token_hash: tokenHash,
      expires_at: expiresAt.toISOString(),
    }),
  });

  return {
    token,
    expiresAt: expiresAt.toISOString(),
  };
}

export default async (req) => {
  if (req.method !== "POST") {
    return json(
      { error: "Méthode non autorisée." },
      405
    );
  }

  if (
    !SUPABASE_URL ||
    !SUPABASE_SECRET_KEY ||
    !PHONE_HASH_SECRET
  ) {
    console.error(
      "ICC Quiz environment variables are missing."
    );

    return json(
      {
        error:
          "Configuration serveur incomplète.",
      },
      500
    );
  }

  try {
    const body = await req.json();

    const callingCode = String(
      body.callingCode ?? "+32"
    ).trim();

    const normalizedPhone =
      normalizePhone(
        callingCode,
        body.phone
      );

    const phoneHash =
      phoneFingerprint(normalizedPhone);

    let user = await findUser(phoneHash);

    let isNewUser = false;

    if (!user) {
      const displayName =
        normalizeName(body.displayName);

      if (!displayName) {
        return json(
          {
            error:
              "Le nom est obligatoire lors de la première connexion.",
          },
          400
        );
      }

      try {
        user = await createUser({
          displayName,
          phoneHash,
          callingCode,
        });

        isNewUser = true;
      } catch (error) {
        user = await findUser(phoneHash);

        if (!user) {
          throw error;
        }
      }
    }

    const session =
      await createSession(user.id);

    const maxAge = SESSION_DAYS * 24 * 60 * 60;

return json(
  {
    ok: true,
    isNewUser,
    expiresAt: session.expiresAt,

    user: {
      id: user.id,
      displayName: user.display_name,
      avatar: user.avatar_key,
    },
  },
  200,
  {
    "set-cookie":
      `__Host-icc_quiz_session=${session.token}; ` +
      `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`,
  }
);
  } catch (error) {
    console.error("Login error:", error);

    return json(
      {
        error:
          error?.message ||
          "Impossible de se connecter.",
      },
      400
    );
  }
};

export const config = {
  path: "/api/login",
};
