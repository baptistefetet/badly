# Badly Web App - Specifications

## 1. Objectif et vision
- Application web legere pour un petit groupe d'amis permettant de creer, partager et rejoindre des sessions de badminton dans differents clubs de Lyon.
- Experience fluide sur desktop et mobile, sans dependances externes, pouvant etre epinglee comme WebApp.
- Temps de mise en oeuvre limite: prioriser la simplicite et la fiabilite.

## 2. Parties prenantes et utilisateurs
- **Utilisateurs finaux**: joueurs de badminton (amis) pouvant tour a tour organiser ou rejoindre une session.
- **Organisateur**: utilisateur qui cree une session; il en est proprietaire.
- **Mainteneur**: personne qui deploie l'app, gere les donnees et intervient en cas de probleme.

## 3. Portee (in/out)
- **Inclus**: gestion d'un compte minimal (nom + mot de passe), creation/suppression de sessions, inscription/desinscription, affichage des sessions, stockage via fichier JSON, UI responsive mobile/desktop, favicon et mode WebApp.
- **Exclus**: paiement en ligne, notifications push, messagerie, traitements batch, import/export des donnees, reseaux sociaux.

## 4. Hypotheses et contraintes
- Backend Node.js sans dependances (API standard + modules natifs), ecoute sur `localhost:3001` en HTTP simple.
- Frontend dans un unique fichier HTML contenant CSS et JavaScript inline ou via balises `style`/`script`.
- Donnees persistees dans `data.json` a la racine. Les lectures/ecritures doivent etre synchronisees pour eviter la corruption, sans mecanisme de cache en memoire.
- Cookie navigateur stocke les identifiants (`name`, `passwordHash`) pour reconnecter automatiquement l'utilisateur sans conserver le mot de passe en clair.
- Favicon unique `favicon.png` (256x256) utilise pour onglets, homescreen et affichage central sur formulaire d'accueil.
- Mode WebApp: fournir un `manifest.json` minimal permettant l'ajout a l'ecran d'accueil; aucun service worker ou cache offline n'est requis.
- Environnement cible: execution locale ou sur un serveur de confiance; aucune scalabilite horizontale requise.

## 5. Roles et regles metier
- Un utilisateur connecte peut creer une session; il en devient automatiquement l'organisateur.
- L'organisateur:
  - ne peut pas rejoindre sa propre session;
  - peut supprimer la session;
  - est automatiquement compte dans le nombre de participants inscrits.
- L'utilisateur special `god` dispose de tous les droits, notamment la suppression de n'importe quelle session (utilise comme mode admin minimal en cas de bug).
- Tout utilisateur connecte peut rejoindre ou quitter une session (sauf le createur sur sa propre session).
- Suppression d'une session concentree: supprime toute la session de la liste.
- Les sessions sont affichees par ordre chronologique (date/heure croissante).
- Les participants s'affichent dans une ligne distincte sous les metadonnees de la session (exclure l'organisateur de cette ligne).

## 6. Exigences fonctionnelles
### 6.1 Authentification et comptes
- Au chargement:
  - lire le cookie `badlyAuth` (format JSON) contenant `name` et `passwordHash`;
  - si le cookie existe, tenter l'authentification automatique via l'endpoint `signin`;
  - en cas d'echec ou d'absence de cookie, montrer un panneau modale d'identification incluant formulaire `signup` et `signin`.
- Formulaire d'inscription:
  - champs requis: `Nom d'utilisateur`, `Mot de passe`, `Confirmation mot de passe` (optionnel si le flux est combine? definir dans open questions);
  - validation: nom unique, mot de passe >= 6 caracteres (a affiner dans validations).
- Formulaire de connexion: nom + mot de passe.
- Depuis l'etat connecte:
  - afficher le nom dans l'angle superieur droit;
  - clic sur le nom ouvre le panneau compte proposant `Se deconnecter` et, si besoin, reaffiche le formulaire.
- Deconnexion: effacer le cookie et rafraichir l'affichage vers l'ecran de connexion.

### 6.2 Gestion des sessions
- Liste principale: toutes les sessions futures; les sessions arrivees a echeance (heure de fin depassee) sont purgees automatiquement lors de l'appel `GET /listSessions`.
- Informations affichees pour chaque session:
  - Date lisible (format `jj/mm/aaaa`), heure de debut (`hh:mm`), duree en minutes ou format heures/minutes;
  - Lieu (nom du club issu de la liste reference, aucune autre information n'est affichee ou stockee);
  - Nombre de participants inscrits vs capacite desiree;
  - Organisateur (prenom/pseudo);
  - Prix par participant (en euros, decimal); afficher `Gratuit` si 0?
  - Liste des participants (prenom/pseudo) sur une ligne: `Participants: Alice, Bob`.
- Actions par session:
  - `Rejoindre`: visible si l'utilisateur n'est pas deja inscrit et n'est pas l'organisateur.
  - `Quitter`: visible si l'utilisateur est deja inscrit (et n'est pas l'organisateur).
  - `Supprimer`: visible uniquement pour l'organisateur ou pour `god`.
- Une session dont la date de debut est depassee ne supporte plus que la suppression; toute autre action renverra une erreur. Le rafraichissement apres suppression recharge la liste via `/listSessions`.
- Bouton flottant `+` (angle inferieur droit) ouvrant un formulaire de creation.
- Formulaire de creation de session:
  - Champs: Date, Heure de debut, Duree (minutes), Lieu (selection dans les clubs defines), Capacite attendue, Prix par participant (EUR).
  - L'utilisateur courant est enregistre comme organisateur et automatiquement ajoute aux participants.
- Gestion des erreurs: messages courts et clairs (ex. `Impossible de rejoindre: session complete`, `Nom deja utilise`).
  - Creation d'une session identique (meme date/heure et meme club) renvoie une erreur immediate.
  - Tentative de rejoindre une session pleine renvoie une erreur immediate.
  - Tentative d'action autre que `Supprimer` sur une session arrivee a echeance renvoie une erreur explicite.

## 7. Experience utilisateur (UI/UX)
- Mise en page responsive s'adaptant a un viewport mobile (>= 320px) et desktop (>= 1024px) avec structure unique.
  - Header fixe: logo (favicon agrandi), titre `Badly`, zone utilisateur dans le coin superieur droit.
  - Contenu principal: liste des sessions en cartes ou blocs.
  - Bouton `+` flottant en bas a droite sur mobile et desktop.
- Palette simple, lisible (texte sombre sur fond clair, accent couleur pour CTA).
- Interactions fluides: feedback visuel sur les boutons, etat de chargement lors des requetes.
- Popup/Modal pour authentification et deconnexion. Accessible via clavier (focus each input, fermer via `Esc`).
- Interface affichee exclusivement en francais (labels, messages, erreurs) bien que le code reste en anglais.
- Internationalisation hors scope: aucune autre langue que le francais n'est prevue.
- PWA/WebApp:
  - `manifest.json` incluant nom, short_name, icones (derivees de `favicon.png`), background_color, display `standalone`.
  - Aucun service worker n'est necessaire puisque aucun cache offline n'est gere.

## 8. Architecture technique
- **Serveur**:
  - Node.js (version 18 LTS recommande) avec modules natifs (`http`, `fs`, `url`, etc.).
  - Serveur HTTP ecoutant sur `0.0.0.0:3001`.
  - Route `/` servant le fichier HTML principal.
  - API RESTful JSON pour les autres endpoints, actions via methodes POST/GET selon detail ci-dessous.
  - Middlewares maison pour parser le corps JSON et gerer les cookies.
  - Gestion de la concurrence lors des ecritures sur `data.json` (utiliser verrou logiciel ou file d'attente). Aucune couche de cache.
- **Client**:
  - Un seul fichier HTML `index.html` contenant markup, styles et scripts.
  - Utilisation du `fetch` natif pour communiquer avec l'API.
  - Gestion de l'etat client (utilisateur, sessions, etats de chargement) en JavaScript vanilla.
  - Stockage du cookie via `document.cookie` (JSON stringifie).
- **Fichiers**:
  - `index.html`, `server.js`, `manifest.json`, `favicon.png`, `data.json`.

## 9. Modele de donnees (data.json)
Proposition de structure JSON:
```json
{
  "users": [
    {
      "name": "alice",
      "passwordHash": "..."
    }
  ],
  "sessions": [
    {
      "id": "sess-uuid",
      "organizer": "alice",
      "club": "Bad's club",
      "datetime": "2023-09-05T18:00:00.000Z",
      "durationMinutes": 90,
      "capacity": 4,
      "pricePerParticipant": 8,
      "participants": ["bob", "charlie"]
    }
  ],
  "clubs": [
    "Bad's club",
    "Rilleux Playgrounds",
    "WeAreSports",
    "Ofluence",
    "Squash Evasion"
  ]
}
```
- `passwordHash`: hash (ex. SHA-256) calcule via `crypto`, stocke dans le fichier et dans le cookie pour comparaison sans mot de passe en clair.
- `id`: identifiant unique (UUID v4 maison ou base sur timestamp).
- `participants`: n'inclut pas l'organisateur.
- `datetime`: format ISO string UTC; convertir localement pour affichage.
- `clubs`: liste reference modifiable uniquement en editant manuellement `data.json`.
- `club`: simple label, sans adresse ni details supplementaires.

## 10. Endpoints API
| Methode | Endpoint        | Auth requise | Description | Corps requete | Reponse succes |
|---------|-----------------|--------------|-------------|---------------|----------------|
| GET     | `/`             | Non          | Retourne `index.html` et assets lies. | N/A | HTML |
| POST    | `/signup`       | Non          | Cree un nouvel utilisateur. | `{ "name": string, "password": string }` | `{ "ok": true, "user": {"name": ...} }` |
| POST    | `/signin`       | Non          | Authentifie un utilisateur. | `{ "name": string, "password": string }` | `{ "ok": true, "user": {"name": ...} }` |
| POST    | `/signout`      | Oui (cookie) | Invalide la session client. | `{}` ou vide | `{ "ok": true }` |
| GET     | `/listSessions` | Oui          | Purge les sessions expirees, retourne les sessions futures triees. | N/A | `{ "ok": true, "sessions": [...] }` |
| POST    | `/createSession`| Oui          | Cree une session. | `{ "datetime": string, "durationMinutes": number, "club": string, "capacity": number, "pricePerParticipant": number }` | `{ "ok": true, "session": {...} }` |
| POST    | `/deleteSession`| Oui          | Supprime une session (organisateur ou `god`). | `{ "sessionId": string }` | `{ "ok": true }` |
| POST    | `/joinSession`  | Oui          | Ajoute l'utilisateur courant a la session. | `{ "sessionId": string }` | `{ "ok": true, "session": {...} }` |
| POST    | `/leaveSession` | Oui          | Retire l'utilisateur courant. | `{ "sessionId": string }` | `{ "ok": true, "session": {...} }` |

- Les reponses en erreur doivent inclure `{ "ok": false, "error": "message lisible" }`.
- Authentification: valider le cookie (relecture de `data.json` pour correspondance) a chaque requete.

## 11. Validation et regles de coherence
- Nom utilisateur: min 3, max 20 caracteres, alphanumerique + `_` ou `-`. Unique (case-insensitive).
- Mot de passe: min 6 caracteres, max 64. Stockage strictement en hash et comparison via hash.
- Session:
  - `datetime`: doit etre dans le futur (>= heure actuelle - tolerance 5 min).
  - `durationMinutes`: > 0 et <= 300.
  - `capacity`: >= 1 et <= 12 (ajuster si besoin).
  - `pricePerParticipant`: >= 0, garder 2 decimales max.
  - Unicite obligatoire sur le couple (`datetime`, `club`).
  - Participants <= capacite; interdire les inscriptions supplementaires si la session est pleine.
  - Une session avec heure de debut depassee est consideree comme fermee; seules les suppressions sont autorisees.
- Limiter a 1 inscription par utilisateur et par session.
- Lors de la suppression d'un utilisateur? (non prevu, a discuter).

## 12. Gestion des cookies et securite
- Cookie `badlyAuth`:
  - Contenu: JSON stringifie contenant `name` et `passwordHash`.
  - Attributs: `max-age` (ex. 30 jours), `path=/`.
- Hash mot de passe: utiliser `crypto.createHash('sha256')` + salt statique minimale.
- Protection CSRF: endpoints acceptent uniquement JSON via `fetch`; valider le header `Content-Type: application/json`.
- Rate limiting non requis (usage amical), mais limiter brute force en ajoutant un petit delai en cas d'echec repetes.
- Validation cote serveur pour toutes les requetes (ne pas se fier uniquement au client).

## 13. Gestion des erreurs et journalisation
- Retourner des statuts HTTP appropries (200 pour succes, 400 pour requete invalide, 401 pour auth echouee, 403 pour acces interdit, 404 pour session inexistante, 500 pour erreur serveur).
- Logger cote serveur: timestamp + endpoint + resultat. Ecriture dans stdout (console) suffit.
- Afficher cote client des notifications non bloquantes (banniere ou toast) pour les erreurs.

## 14. Tests et validation
- Tests manuels cibles:
  - Inscription + auto-login via cookie.
  - Authentification echouee (mot de passe incorrect).
  - Creation, jointure, quit, suppression de session dans divers cas.
  - Verification qu'une session pleine refuse toute nouvelle inscription.
  - Verification que `GET /listSessions` purge les sessions arrivees a echeance et qu'aucune action autre que delete n'est possible sur une session passee.
  - Affichage responsive (mobile viewport ~375px, desktop >= 1280px).
  - Ajout a l'ecran d'accueil via le `manifest` (sans cache offline).
- Tests automatises: scripts Node basiques pour valider les methodes de lecture/ecriture `data.json` (optionnel vu scope).

## 15. Deploiement et exploitation
- Lancement via `node server.js`.
- Donnees persistees dans `data.json` (sauvegarde regulierement en externe en cas de crash).
- Mettre en place une tache cron externe pour sauvegarder le fichier? (hors scope mais a noter).
- Monitoring leger: logs consultables manuellement.

## 16. Questions ouvertes et prochaine iteration
Aucune question ouverte pour le moment.

---
Document a reviser selon les retours du groupe avant implementation.
