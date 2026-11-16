// Message action buttons dispatch through ONE delegated listener on the feed
// (buttons carry data-act; the listener resolves the message via
// .scp-msg[data-id]). Guards the wiring: every act reaches its handler with
// (wrap, msg), unknown acts are ignored, and a second setup call does not
// double-bind.

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/index.js', () => ({
    ST_WorldInfo: null,
    ST_Utils: null,
    extVersion: 'test',
    __extPath: 'third-party/ST-Copilot',
    refreshSessionDropdown: () => {},
}));

vi.mock('../src/ui/msg-actions.js', () => ({
    getSwipesForMsg: vi.fn(),
    navigateSwipe: vi.fn(),
    updateSwipeBar: vi.fn(),
    _runSwipeRegen: vi.fn(),
    _refreshSwipeBars: vi.fn(),
    _refreshContinueBtns: vi.fn(),
    scrollToBottom: vi.fn(),
    saveScrollPosition: vi.fn(),
    restoreScrollPosition: vi.fn(),
    smartScrollToBottom: vi.fn(),
    setupMessagesScrollTracking: vi.fn(),
    setupCodeBlockActions: vi.fn(),
    addHistoryToSwipe: vi.fn(),
    handleCopy: vi.fn(),
    handleEdit: vi.fn(),
    handleMessageRegen: vi.fn(),
    handleDelete: vi.fn(),
}));

vi.mock('../src/session.js', () => ({
    getSettings: vi.fn(() => ({})),
    saveSettings: vi.fn(),
    getCurrentSession: vi.fn(() => MSG_SESSION),
    saveSessionsToMetadata: vi.fn(),
    deleteMsg: vi.fn(),
    truncateAfter: vi.fn(),
    truncateFrom: vi.fn(),
    expandMacros: vi.fn((s) => s),
    getEffectiveSettings: vi.fn(() => ({})),
    getBindingKey: vi.fn(),
    initChatBucket: vi.fn(),
    isMessageStarred: vi.fn(() => false),
    toggleStarMessage: vi.fn(() => true),
}));

vi.mock('../src/ui/chat-shared.js', () => ({
    apiMod: { runContinue: vi.fn() },
    uiWinMod: null,
    uiWdgMod: null,
    uiSetMod: null,
    featCharUiMod: null,
    _renderFromBySession: new Map(),
    MSG_RENDER_WINDOW: 40,
}));

vi.mock('../src/ui/render-msg.js', () => ({
    _renderMsgBodyContent: vi.fn(),
    _updateMsgTokenCount: vi.fn(),
    postProcessHTMLBlocks: vi.fn(),
}));

vi.mock('../src/ui/search.js', () => ({
    clearSearchHighlights: vi.fn(),
    updateSearchCount: vi.fn(),
    performSearch: vi.fn(),
}));

vi.mock('../src/ui/chat-picker.js', () => ({
    closeChatPicker: vi.fn(),
    updatePickBtnState: vi.fn(),
}));

const MSG_SESSION = { messages: [{ id: 'm1', role: 'assistant', content: 'hi' }] };

const { setupMsgActionsDelegation } = await import('../src/ui/session-view.js');
const msgActions = await import('../src/ui/msg-actions.js');
const chatShared = await import('../src/ui/chat-shared.js');

function buildFeed() {
    document.getElementById('scp-messages')?.remove();
    const feed = document.createElement('div');
    feed.id = 'scp-messages';
    const wrap = document.createElement('div');
    wrap.className = 'scp-msg';
    wrap.dataset.id = 'm1';
    const row = document.createElement('div');
    row.className = 'scp-msg-actions';
    for (const act of ['copy', 'edit', 'regen', 'delete', 'star', 'continue']) {
        const b = document.createElement('button');
        b.className = 'scp-msg-btn';
        b.dataset.act = act;
        row.appendChild(b);
    }
    wrap.appendChild(row);
    feed.appendChild(wrap);
    document.body.appendChild(feed);
    return feed;
}

const clickAct = (act) => {
    document.querySelector(`#scp-messages .scp-msg-btn[data-act="${act}"]`).click();
};

describe('setupMsgActionsDelegation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        buildFeed();
        setupMsgActionsDelegation();
    });

    it('dispatches copy to the handler with the resolved message', () => {
        clickAct('copy');
        expect(msgActions.handleCopy).toHaveBeenCalledTimes(1);
        expect(msgActions.handleCopy).toHaveBeenCalledWith(MSG_SESSION.messages[0]);
    });

    it('dispatches wrap-consuming actions with (wrap, msg)', () => {
        clickAct('edit');
        const wrap = document.querySelector('#scp-messages .scp-msg');
        expect(msgActions.handleEdit).toHaveBeenCalledWith(wrap, MSG_SESSION.messages[0]);
        clickAct('delete');
        expect(msgActions.handleDelete).toHaveBeenCalledWith(wrap, MSG_SESSION.messages[0]);
    });

    it('continue reaches apiMod.runContinue with the session and message id', () => {
        clickAct('continue');
        expect(chatShared.apiMod.runContinue).toHaveBeenCalledWith(MSG_SESSION, 'm1');
    });

    it('star toggles state on the button and the wrap', () => {
        const wrap = document.querySelector('#scp-messages .scp-msg');
        clickAct('star');
        expect(wrap.classList.contains('scp-msg-starred')).toBe(true);
        expect(document.querySelector('.scp-msg-btn[data-act="star"]').classList.contains('starred')).toBe(true);
    });

    it('clicks outside action buttons do nothing', () => {
        document.querySelector('#scp-messages .scp-msg').click();
        expect(msgActions.handleCopy).not.toHaveBeenCalled();
    });

    it('a second setup call does not double-bind the listener', () => {
        setupMsgActionsDelegation();
        clickAct('copy');
        expect(msgActions.handleCopy).toHaveBeenCalledTimes(1);
    });
});
