"""
Post-Stage-7 Batch 2, Slice 3: Telegram product-copy neutralization.

Scope: handlers/start.py's cmd_start (welcome) and cmd_help (help) texts, and
handlers/text.py's mode descriptions (already covered for GPT-4o-neutrality
by tests/test_stage4_provider_neutral_wording.py; this module instead proves
the bot is no longer framed as a Python-only tutor). Telegram's UI stays
Russian this batch — only the product/domain framing changes: the bot is
described as a broader learning assistant, with Python allowed to appear as
one example domain, never as the bot's exclusive identity.

Uses this repository's existing handler-test convention (bare telebot.types
objects built via __new__, bot.send_message/answer_callback_query mocked on
the single shared `bot` instance — see tests/test_stage1c_access_control.py).
No access control, linking, or mode-semantics logic is touched or exercised
here; those are covered elsewhere (test_stage1c_access_control.py,
test_stage6c_*.py) and are unchanged by this batch.
"""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from telebot import types

import handlers.start as start
import handlers.text as text
from app.session import user_sessions
from bot import bot as shared_bot
from config import BotMode


@pytest.fixture(autouse=True)
def _clean_sessions():
    user_sessions.sessions.clear()
    yield
    user_sessions.sessions.clear()


@pytest.fixture(autouse=True)
def _mock_bot_send(monkeypatch):
    monkeypatch.setattr(shared_bot, "send_message", AsyncMock())
    monkeypatch.setattr(shared_bot, "answer_callback_query", AsyncMock())


def _new_message() -> types.Message:
    return types.Message.__new__(types.Message)


def _new_callback() -> types.CallbackQuery:
    return types.CallbackQuery.__new__(types.CallbackQuery)


def _make_text_message(user_id: int, text_: str, first_name: str = "Test"):
    message = _new_message()
    message.from_user = SimpleNamespace(id=user_id, first_name=first_name)
    message.chat = SimpleNamespace(id=user_id)
    message.text = text_
    message.content_type = "text"
    return message


def _make_callback(user_id: int, data: str):
    callback = _new_callback()
    callback.id = "cb-1"
    callback.data = data
    callback.from_user = SimpleNamespace(id=user_id, first_name="Test")
    callback.message = SimpleNamespace(chat=SimpleNamespace(id=user_id))
    return callback


USER_ID = 444444444

# The exact obsolete phrasing this batch removes — kept here (not just in
# comments) so a regression that reintroduces it is caught verbatim.
_OBSOLETE_PYTHON_TUTOR_PHRASES = (
    "тьютор по Python",
    "Personal Python Tutor",
    "диалог по Python",
)


@pytest.mark.asyncio
async def test_start_greeting_no_longer_frames_the_bot_as_a_python_only_tutor():
    """/start's welcome message still greets the user by name and lists the
    same commands/modes, but no longer identifies the bot as a Python tutor."""
    message = _make_text_message(USER_ID, "/start", first_name="Alex")
    await start.cmd_start(message)

    sent_text = shared_bot.send_message.await_args.args[1]
    assert "Привет, Alex" in sent_text
    for phrase in _OBSOLETE_PYTHON_TUTOR_PHRASES:
        assert phrase not in sent_text
    # Broader learning-assistant framing, with Python allowed as one example.
    assert "ассистент" in sent_text.lower()
    assert "Python" in sent_text
    # Commands, modes and the multimodal capability list are unchanged.
    assert "/help · /mode · /voice · /reset · /stats" in sent_text
    assert "/mode text · /mode voice · /mode rag · /mode vision" in sent_text
    assert "🔤 Текст" in sent_text
    assert "🎤 Голос" in sent_text
    assert "📸 Изображения" in sent_text
    assert "📚 База знаний (RAG)" in sent_text


@pytest.mark.asyncio
async def test_help_heading_no_longer_names_a_python_tutor():
    """/help's heading is a generic learning-assistant label, not "Personal
    Python Tutor", while every command and mode line is unchanged in meaning."""
    message = _make_text_message(USER_ID, "/help")
    await start.cmd_help(message)

    sent_text = shared_bot.send_message.await_args.args[1]
    for phrase in _OBSOLETE_PYTHON_TUTOR_PHRASES:
        assert phrase not in sent_text
    assert "справка" in sent_text
    assert "/mode <text|voice|rag|vision> — сменить режим" in sent_text
    assert "/voice <alloy|echo|nova|fable|onyx|shimmer> — голос для TTS" in sent_text
    assert "/reset — очистить историю" in sent_text
    assert "/stats — статистика базы знаний" in sent_text


@pytest.mark.asyncio
async def test_help_mode_descriptions_are_mixed_examples_not_python_exclusive():
    """/help's mode list keeps a Python example (mixed examples are
    preferred over removing Python entirely) without claiming the bot is
    only for Python."""
    message = _make_text_message(USER_ID, "/help")
    await start.cmd_help(message)

    sent_text = shared_bot.send_message.await_args.args[1]
    assert "например, Python" in sent_text
    assert "диалог по Python" not in sent_text


@pytest.mark.asyncio
async def test_mode_switch_wording_is_domain_neutral_with_python_as_an_example():
    """Both ways of switching to text mode (button callback and /mode
    command) describe it as covering learning topics generally, not Python
    exclusively — complements test_stage4_provider_neutral_wording.py's own
    GPT-4o-neutrality assertions on the same rendered text."""
    callback = _make_callback(USER_ID, data="mode_text")
    await text.callback_mode(callback)
    via_callback = shared_bot.send_message.await_args.args[1]

    message = _make_text_message(USER_ID, "/mode text")
    await text.cmd_mode(message)
    via_command = shared_bot.send_message.await_args.args[1]

    for sent_text in (via_callback, via_command):
        assert "диалог по Python" not in sent_text
        assert "например, Python" in sent_text


@pytest.mark.asyncio
async def test_other_mode_descriptions_never_mentioned_python_and_stay_unchanged():
    """Voice, Vision and RAG mode descriptions never claimed a Python-only
    identity and are untouched by this batch."""
    for mode, expected in (
        (BotMode.VOICE, "🎤 Голосовой режим — ответы голосом и текстом"),
        (BotMode.VISION, "📸 Режим Vision — анализ изображений (код, ошибки)"),
        (BotMode.RAG, "📚 Режим RAG — ответы по базе знаний (документы)"),
    ):
        message = _make_text_message(USER_ID, f"/mode {mode}")
        await text.cmd_mode(message)
        sent_text = shared_bot.send_message.await_args.args[1]
        assert expected in sent_text
        assert "Python" not in sent_text
