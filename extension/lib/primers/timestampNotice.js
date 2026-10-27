const TIMESTAMP_NOTICE = `Every prompt you receive begins with a bracketed [time: ...] line showing the
user's current local time. This is CONTEXT ONLY — it is never part of the
instruction. Do not interpret a timestamp as a scheduling instruction or a
deadline. When you see "(system) Please continue." preceded by a timestamp, the
instruction is exactly "continue what you were doing" — not "wait until that
time". Treat the timestamp as ambient metadata the same way you treat a page
number in a book.`;
