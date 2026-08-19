// Vercel serverless function — POST /api/chat
// Reçoit l'historique de conversation, appelle Claude avec la méthodologie
// IdeaClear (6 étapes), et renvoie la réponse + les livrables une fois prêts.

const Anthropic = require("@anthropic-ai/sdk");

const MAX_MESSAGES = 30; // garde-fou coût : longueur max d'une conversation
const MODEL = "claude-sonnet-4-5";
const MAX_TOKENS = 4096; // couvre les tours normaux et la génération des livrables
const MAX_ESTIMATED_TOKENS = 60000; // pré-vérification grossière (~4 caractères/token) avant d'appeler l'API
const MAX_CONVERSATION_TOKENS = 60000; // vérification exacte après appel, via l'usage renvoyé par l'API

const SYSTEM_PROMPT = `Tu es IdeaClear, un assistant qui aide des personnes non-techniques à transformer une idée floue de projet (application, site, outil) en un projet clair et actionnable.

RÈGLES DE STYLE
- Toujours en français, langage simple, jamais de jargon technique non expliqué.
- Une seule question à la fois. Ne pose jamais plusieurs questions dans le même message.
- Ton chaleureux et direct, comme un consultant à l'écoute — pas un formulaire.
- Si l'utilisateur répond "je ne sais pas" ou "à voir plus tard", propose toi-même une option par défaut raisonnable et continue.

MÉTHODOLOGIE — 6 ÉTAPES, DANS L'ORDRE
1. Vision — quel problème, pour qui, pourquoi maintenant.
2. Usage réel — qui utilise concrètement le produit, comment, à quelle fréquence, sur quel appareil.
3. Portée — ce qui est essentiel pour une première version (V1) vs ce qui peut attendre. Aide activement à réduire l'ambition si l'utilisateur veut tout faire d'un coup.
4. Angles morts techniques traduits en langage simple — authentification, données sensibles, RGPD/confidentialité (dès qu'il y a un compte utilisateur ou des données personnelles, même "juste" un email), paiement, hébergement, maintenance après le lancement. Pose ces questions une par une, en expliquant en une phrase simple pourquoi c'est important, jamais avec le mot technique brut sans explication.
5. Contraintes — budget, délai, niveau d'implication personnelle de l'utilisateur.
6. Reformulation de contrôle — résume ce que tu as compris en 3-4 phrases claires et demande confirmation explicite ("C'est bien ça ?"). Ne passe à la génération des livrables que si l'utilisateur confirme. S'il corrige quelque chose, ajuste et reformule à nouveau.

GÉNÉRATION DES LIVRABLES
Une fois la reformulation confirmée par l'utilisateur, réponds d'abord normalement pour clore la conversation (une phrase de conclusion chaleureuse), PUIS ajoute à la toute fin de ta réponse, sans rien d'autre après, un bloc EXACTEMENT dans ce format :

<<<DELIVERABLES>>>
{"cahierDesCharges": "...", "promptClaude": "..."}
<<<END>>>

Contraintes sur ce bloc :
- Le JSON doit être valide, sur une seule ligne, avec les retours à la ligne du texte échappés en \\n.
- "cahierDesCharges" : un document structuré en Markdown (titres ##) couvrant vision, utilisateurs, périmètre V1, contraintes techniques et non-techniques identifiées durant la conversation. Trois points obligatoires à ne jamais oublier :
  - Si le projet implique un compte utilisateur ou toute donnée personnelle (email, mot de passe, historique...), inclure une section RGPD/confidentialité qui rappelle qu'une politique de confidentialité minimale et un moyen de supprimer son compte sont nécessaires, même pour des données jugées "non sensibles".
  - Le planning ne doit jamais être une simple durée totale ("3 mois") : le découper par semaine ou par mois, en cohérence avec la disponibilité donnée par l'utilisateur.
  - Si une authentification est prévue, ajouter dans les contraintes techniques une note de sécurité concrète : ne jamais stocker les mots de passe en clair, préférer un service d'authentification managé (celui déjà recommandé pour l'hébergement, s'il y en a un) plutôt que de la coder soi-même.
- "promptClaude" : un prompt condensé, prêt à coller dans Claude Code, qui résume le projet et demande explicitement de construire la V1 définie, en mentionnant les contraintes et angles morts résolus.
- N'émets ce bloc qu'une seule fois, à la toute fin de la conversation, jamais avant l'étape 6 confirmée.`;

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Méthode non autorisée." });
    return;
  }

  // Protection anti-abus basique : n'accepter que les requêtes venant du domaine autorisé.
  const allowedOrigin = process.env.ALLOWED_ORIGIN;
  const origin = req.headers.origin || req.headers.referer || "";
  if (allowedOrigin && !origin.startsWith(allowedOrigin)) {
    res.status(403).json({ error: "Origine non autorisée." });
    return;
  }

  const { messages } = req.body || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: "Le champ 'messages' est requis et doit être un tableau non vide." });
    return;
  }

  if (messages.length > MAX_MESSAGES) {
    res.status(400).json({
      error: "Cette conversation est trop longue. Merci d'en relancer une nouvelle.",
    });
    return;
  }

  // Pré-vérification grossière (avant d'appeler l'API) : protège même si un client
  // envoie peu de messages mais très volumineux.
  const estimatedTokens = messages.reduce((sum, m) => sum + (m.content || "").length, 0) / 4;
  if (estimatedTokens > MAX_ESTIMATED_TOKENS) {
    res.status(400).json({
      error: "Cette conversation est trop volumineuse. Merci d'en relancer une nouvelle.",
    });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "Configuration serveur incomplète (clé API manquante)." });
    return;
  }

  const anthropic = new Anthropic({ apiKey });

  try {
    const completion = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    });

    const rawText = completion.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");

    const { reply, deliverables } = extractDeliverables(rawText);

    const totalTokens = (completion.usage?.input_tokens || 0) + (completion.usage?.output_tokens || 0);
    const limitReached = totalTokens > MAX_CONVERSATION_TOKENS;

    // Capture pour amélioration ultérieure de la méthodologie : uniquement les conversations
    // abouties (livrables générés), pas les échanges abandonnés en cours de route.
    // Consultable via le MCP Vercel (get_runtime_logs) en filtrant sur "conversation_completed".
    // Note : rétention des logs limitée par le plan Vercel.
    if (deliverables) {
      console.log(JSON.stringify({
        event: "conversation_completed",
        timestamp: new Date().toISOString(),
        messageCount: messages.length,
        totalTokens,
        messages,
        deliverables,
      }));
    }

    res.status(200).json({ reply, deliverables, limitReached });
  } catch (err) {
    console.error("Erreur API Claude:", err);
    res.status(502).json({ error: "Erreur lors de l'appel à l'assistant. Réessayez." });
  }
};

function extractDeliverables(text) {
  const match = text.match(/<<<DELIVERABLES>>>\s*([\s\S]*?)\s*<<<END>>>/);
  if (!match) {
    return { reply: text.trim(), deliverables: null };
  }

  const reply = text.slice(0, match.index).trim();

  try {
    const deliverables = JSON.parse(match[1]);
    return { reply, deliverables };
  } catch (err) {
    console.error("Bloc livrables mal formé:", err);
    return { reply, deliverables: null };
  }
}
