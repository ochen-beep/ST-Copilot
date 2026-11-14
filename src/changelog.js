// Changelog data (displayed by the changelog modal in ui-widgets).
// Pure data: kept out of constants.js to stop it drifting past the size cap.
    // ─── Changelog Data ──────────────────────────────────────────────────────────
export const CHANGELOG = [
    {
        version: '2.10.1',
        date: '11/10/2026',
        announce: true,
        notes: [
            '<strong>Исправлена «тихая смерть» запроса</strong> — если соединение обрывалось без команды пользователя, генерация завершалась молча. Теперь показывается диалог ошибки, а настримленный фрагмент сохраняется как сообщение.',
            '<strong>Watchdog увеличен до 5 минут</strong> — генерация прерывается по тишине провайдера через 300 секунд вместо 180.',
            '<strong>Окно не уезжает за экран</strong> — восстановленные размер и позиция окна подрезаются под текущий вьюпорт.',
            '<strong>Ghost Mode удалён</strong> — режим призрака и его настройки убраны из интерфейса.',
            '<strong>Убрана кнопка «Свернуть»</strong> — оставлена только «Скрыть».'
        ],
    },
    {
        version: '2.10.0',
        date: '7/5/2026',
        announce: true,
        notes: [
            '<strong>Полная локализация</strong> — Интерфейс, настройки и все промпты ИИ переведены на русский язык (технические токены сохранены).',
            '<strong>Новый запуск</strong> — Плавающая иконка заменена на inline-кнопку 🧠 в панели быстрых ответов SillyTavern.',
            '<strong>Полноэкранный мобильный режим</strong> — Окно разворачивается на весь экран с учётом хрома ST (top-bar + send_form) через 100dvh.',
            '<strong>Максимальная производительность</strong> — Убраны blur/прозрачность (backdrop-filter), тяжёлые тени, wobble-физика перетаскивания и кастомные фоны image/video. Темы конвертированы в solid-цвета.',
            '<strong>Окно всегда непрозрачное</strong> — Прозрачность теперь используется только в режиме призрака (Ghost Mode).'
        ],
    },
    {
        version: '2.9.0',
        date: '7/2/2026',
        announce: true,
        notes: [
            '<strong>Character Manager</strong> — New interface to edit character fields and configure per-character context inclusion rules.',
            '<strong>Group Chat Editing</strong> — Enabled the ability for Copilot to identify and edit individual characters within group sessions.',
            '<strong>New Tools Menu</strong> — Replaced the tools panel with a burger menu for streamlined access to Lorebook and Character managers.',
            '<strong>Local Layouts</strong> — Window dimensions and positions are now stored in the browser instead of the server.',
            '<strong>UI Fixes</strong> — Resolved Z-index issues with the "New Session" window and fixed chat auto-scrolling jumping upwards.',
            '<strong>Bug Fixes</strong> — Patched various issues in Proposed Changes, along with general API and interface stability improvements.'
        ],
    },
    {
        version: '2.8.3',
        date: '6/20/2026',
        announce: false,
        notes: [
            '<strong>Search Enhancements</strong> — Search tools now support multiple queries simultaneously for better information retrieval.',
            '<strong>Session Reliability</strong> — Resolved critical bugs affecting the deletion and management of Copilot sessions.',
            '<strong>Lorebook UI</strong> — Restored lorebook source icons and fixed a bug where "Proposed Changes" would reappear after application.',
            '<strong>World Info Drawer</strong> — Fixed various extension bugs (Special thanks to @Haruny for the debugging and fixes).',
            '<strong>UI/UX Polishing</strong> — Addressed several layout inconsistencies and minor interface bugs.'
        ],
    },
    {
        version: '2.8.2',
        date: '6/16/2026',
        announce: false,
        notes: [
            '<strong>Character Management</strong> — Copilot can now access and modify Name, Main Prompt Override, and Post-History Instructions.',
            '<strong>Lorebook API</strong> — Added <code>get_lorebooks</code> tool and upgraded <code>search_lorebook_entries</code> with <code>is_constant</code> and <code>is_outlet</code> parameters.',
            '<strong>Dynamic Outlets</strong> — Enabled AI autonomy for creating and modifying Lorebook Outlets (requires Lorebook Prompt reset to default).',
            '<strong>Chat Management</strong> — Added support for renaming the current chat via Proposed Chat Changes.',
            '<strong>Stability & Tokens</strong> — Fixed critical session deletion bugs, improved token counting accuracy, and optimized save-lock logic.'
        ],
    },
    {
        version: '2.8.1',
        date: '6/15/2026',
        announce: false,
        notes: [
            '<strong>World Info Outlets</strong> — Added full support for the <code>{{outlet::name}}</code> macro syntax for dynamic content injection.',
            '<strong>UI Navigation</strong> — Repositioned tab buttons in the settings panel for improved accessibility and user flow.',
            '<strong>Stability</strong> — Fixed various minor regressions and internal logic bugs.'
        ],
    },
    {
        version: '2.8.0',
        date: '6/11/2026',
        announce: false,
        notes: [
            '<strong>Tools & Agency</strong> — Copilot can now independently gather information using the new Tools system.',
            '<strong>Persistent Memory</strong> — Introduced cross-session memory with Global, Character, Chat, and Session scoping.',
            '<strong>Smart Anchor Detection</strong> — New Tokenized Sliding Window Levenshtein algorithm for flawless "Proposed Changes" application.',
            '<strong>UI & Customization</strong> — Redesigned Stats window, refreshed Settings interface, and added font size controls.',
            '<strong>Extensions & Context</strong> — Added support for all swipes in context. Also for Summaryception, and Aspect:Evolutia extensions.',
            '<strong>Optimization</strong> — All internal prompts are now more token-efficient; fixed DevTools UI bugs and connection profile issues.'
        ],
    },
    {
        version: '2.7.2',
        date: '5/29/2026',
        announce: false,
        notes: [
            '<strong>Shortcuts Overlay</strong> — Introduced a dedicated "Shortcuts" configuration window in the settings panel.',
            '<strong>Context-Aware Search</strong> — Refined the search shortcut to trigger exclusively when the Copilot window is active.',
            '<strong>Character Factory Fixes</strong> — Resolved several bugs affecting character creation and metadata initialization.',
            '<strong>Asset Optimization</strong> — Overhauled background storage logic for better performance and reduced storage overhead.'
        ],
    },
    {
        version: '2.7.1',
        date: '5/28/2026',
        announce: false,
        notes: [
            '<strong>Character Tagging</strong> — Added the ability to modify the "tags" field for already existing characters.',
            '<strong>Low Performance Mode</strong> — Introduced a new toggle to optimize resource usage on lower-end hardware.',
            '<strong>Session Stability</strong> — Completely overhauled the session saving system to prevent spontaneous session loss and data corruption.',
            '<strong>General Optimization</strong> — Improved core logic for better performance and overall stability of ST-Copilot. Fixed AI Generation errors.'
        ],
    },
    {
        version: '2.7.0',
        date: '5/27/2026',
        announce: false,
        notes: [
            '<strong>Proposed Chat Edits</strong> — Bulk-modify, delete, or hide message ranges using natural language instructions.',
            '<strong>File Attachments & Vision</strong> — Support for text/image uploads with vision model integration and an internal previewer.',
            '<strong>Message Swiping</strong> — Regenerate Copilot responses and navigate through multiple swipe iterations.',
            '<strong>Multimedia Backgrounds</strong> — Custom image/video backgrounds (local or URL) with adjustable dimming.',
            '<strong>Character Creator</strong> — Added "tags" field support and optimized generation prompts for AI-assisted creation.',
            '<strong>Configuration Sync</strong> — AI settings are now linked to Configuration Profiles and Session Overrides.',
            '<strong>UX Enhancements</strong> — Added "Always Off" Lorebook state, sender-based group selection in context picker, and focus-aware notification sounds.',
            '<strong>UI & Maintenance</strong> — Improved "Save" button feedback, better theme support for lists, and optimized generation logic.'
        ],
    },
    {
        version: '2.5.1',
        date: '5/22/2026',
        announce: false,
        notes: [
            '<strong>Continue Message</strong> — Added a "Continue" button to extend the last Copilot generation.',
            '<strong>Debug Export</strong> — Introduced a downloadable debug log in settings for easier troubleshooting (refreshes on page load).',
            '<strong>Smooth Streaming</strong> — Fixed chat scrolling behavior, allowing users to scroll up during active message streaming.',
            '<strong>Bug Fixes</strong> — Potential fix for the "profile not found" error and minor stability improvements.'
        ],
    },
    {
        version: '2.5.0',
        date: '5/20/2026',
        announce: false,
        notes: [
            '<strong>Character Card Manager</strong> — You can now create new characters entirely from scratch or edit existing card fields directly within the extension.',
            '<strong>Massive Token Optimization</strong> — "Proposed Changes" now uses a smart search-and-replace method, reducing token consumption by over 80% (Huge thanks to Steel-skull for the PR!).',
            '<strong>Robust Parsing</strong> — The system now successfully finds and applies "proposed changes" blocks even if the AI makes formatting mistakes.',
            '<strong>Session Management</strong> — Added the ability to export and import sessions. Under-the-hood session saving has also been rewritten to be much more efficient.',
            '<strong>UI, Sounds & Polish</strong> — Added a generation-complete sound notification, soothing window wobble physics, smooth chart animations in Stats, and new Streaming modes (Auto, Force On, Force Off).',
            '<strong>Lorebook Updates</strong> — Added a "constant" parameter for proposed changes and moved toggles to the main Settings. ⚠️ <em>Important: Please reset your Lorebook AI Edit prompt to default!</em>',
            '<strong>Mobile & Fixes</strong> — The Enter key on mobile keyboards now correctly inserts line breaks instead of sending messages. Fixed mobile UI headers, resolved duplicate user message bugs, and redesigned system message outputs.'
        ],
    },    
    {
        version: '2.3.0',
        date: '5/10/2026',
        announce: false,
        notes: [
            '<strong>Stream Support</strong> — Added streaming support so you can see generations in real-time.',
            '<strong>Reasoning Blocks</strong> — Added support for displaying Reasoning blocks',
            '<strong>Regex Support</strong> — Clean up formatting and fluff from chat messages included in the context.',
            '<strong>Preset Customization</strong> — Modify QuickPrompts and SystemPrompts presets directly (SystemPrompts handled via session override).',
            '<strong>Favorite Messages</strong> — You can now mark specific messages as Favorites.',
            '<strong>In-app Changelog</strong> — Added a Changelog window to easily track new updates.',
            '<strong>Fixes & Polish</strong> — Synced chat context picker numbering with ST (0 to N), fixed Lorebook context persistence after disconnection, and improved the default Lorebook edit prompt.'
        ],
    },
    {
        version: '2.0.0',
        date: '5/03/2026',
        announce: false,
        notes: [
            '<strong>Messages Payload</strong> — Handpick specific messages from the chat history and feed them directly to the AI.',
            '<strong>Quick Prompts</strong> — Fully customizable prompt buttons with emoji icons.',
            '<strong>Ghost Mode</strong> — Copilot can now become semi-transparent and completely click-through.',
            '<strong>Expanded Context Awareness</strong> — Context now includes Character Note, Example of Dialogue, and respects settings overrides.',
            '<strong>Temporary Sessions</strong> — Create sessions that automatically delete themselves when you switch.',
            '<strong>Usage Stats</strong> — A new interactive Statistics window to track your metrics.',
            '<strong>UI & QoL Enhancements</strong> — Save edited messages without regenerating, mobile responsive improvements, HTML support, and clean connecting lines for lists.'
        ],
    },
    {
        version: '1.9.0',
        date: '4/28/2026',
        announce: false,
        notes: [
            '<strong>Integrated Settings Window</strong> — Dedicated settings UI for seamless adjustments.',
            '<strong>Session-Specific Configuration</strong> — Override global settings for individual sessions.',
            '<strong>Dynamic Context Scaling</strong> — The CTX slider dynamically adjusts its range based on chat length.',
            '<strong>Advanced In-Chat Search</strong> — Quickly locate specific information using (Ctrl + F).',
            '<strong>Theme Portability</strong> — Import and Export custom themes as JSON. Added the new "Dark Sky" preset.'
        ],
    },
    {
        version: '1.7.2',
        date: '4/27/2026',
        announce: false,
        notes: [
            '<strong>Comfortable Color Picker</strong> — Choose colors natively without leaving the app.',
            '<strong>Default Colors</strong> — Individually reset specific colors to the original theme defaults.',
            '<strong>Resizable edit window</strong> — You can now manually resize the "content" window in the Lorebook Manager.'
        ],
    },
    {
        version: '1.7.1',
        date: '4/26/2026',
        announce: false,
        notes: [
            '<strong>Expandable Entry Descriptions</strong> — Click to expand chat entry descriptions.',
            '<strong>Lorebook Dropdowns</strong> — Individual Lorebook selection dropdowns for each entry proposal.',
            '<strong>Data Protection</strong> — Added unsaved changes warnings when switching profiles.',
            '<strong>New Macro</strong> — Added support for {{active_lorebooks}}.'
        ],
    },
    {
        version: '1.7.0',
        date: '4/26/2026',
        announce: false,
        notes: [
            '<strong>AI Lorebook Management</strong> — Copilot AI now actively assists in world-building (AI-Edit).',
            '<strong>Interactive Proposals</strong> — AI generates Proposal Cards to review, edit, or reject changes via a Diff View modal.',
            '<strong>Lorebook Manager UI</strong> — Added manual overrides, Auto-Keywords, and Active Indicators.',
            '<strong>String Trimming</strong> — Automatically remove specific tags (like &lt;think&gt; blocks) from AI responses.',
            '<strong>Persistent Icon</strong> — Option to keep the floating dock icon visible at all times.'
        ],
    }
];
