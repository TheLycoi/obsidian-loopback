/*
The ordering TCK-076 is entirely about: from one highlight, the capture
must be written to the inbox before anything else happens, so an
interrupted or failed draft can never lose the passage. This module owns
only that ordering, as three already-built async steps run strictly in
sequence. It has no dependency on the Obsidian API, so the ordering itself
is proven with fake capture, reveal, and draft functions and no vault at
all, the same separation capture-decision.ts uses for the capture record
itself: pure logic here, thin glue in main.ts wiring the real steps.

Drafting stays off the capture path even though it is the third step run
here, not a separately dispatched command: this function does not wait for
draft() to finish before it returns. Capture and reveal are always fully
awaited first, so the passage is safe on disk and the sidebar has already
shown it pending before a model call is even started. What happens after
that, whether the call takes ten seconds or times out, cannot add latency
to a step the reviewer already saw complete.
*/

export interface CaptureAndDraftSteps {
	/** Writes the capture to the inbox. Must resolve before reveal or draft run. Throwing here stops the whole sequence: reveal and draft never start for a passage that was never saved. */
	capture: () => Promise<void>;
	/** Opens or focuses the review sidebar so the reviewer sees the capture land, in whatever pending state it has before any draft exists. Runs only after capture has resolved. */
	reveal: () => Promise<void>;
	/** Starts drafting. Invoked only after capture and reveal have both resolved, and never awaited by runCaptureAndDraft itself, so a slow or failing model call cannot delay the moment this function returns. */
	draft: () => Promise<void>;
}

/**
 * Run capture, then reveal, then draft, strictly in that order. Capture and
 * reveal are each awaited before the next step starts. draft is invoked
 * last and is deliberately not awaited here: its own errors are the
 * caller's concern to catch and surface (the sidebar's failure state, not
 * this function), and the promise this function returns settles once
 * reveal completes rather than waiting on a model call.
 */
export async function runCaptureAndDraft(steps: CaptureAndDraftSteps): Promise<void> {
	await steps.capture();
	await steps.reveal();
	void steps.draft();
}
