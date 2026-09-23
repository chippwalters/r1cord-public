package com.chippwalters.r1cord.recording

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Behavior tests for the energy VAD gate: thresholds by sensitivity, post-roll and
 * hangover timing, confirmation voting, priming after a manual resume, and the
 * adaptive noise floor. Levels are in dBFS per 20 ms frame, as processFrame feeds them.
 */
class VoiceGateTest {
    private fun frames(gate: VoiceGate, db: Float, count: Int): List<Decision> =
        List(count) { gate.evaluate(db) }

    /** Drive a balanced gate through speech then 2 s of silence until it closes. */
    private fun gatedGate(sensitivity: Int): VoiceGate {
        val gate = VoiceGate(sensitivity)
        frames(gate, -20f, 30)
        frames(gate, -90f, HANG_MS / FRAME_MS + 5)
        assertTrue("fixture must reach GATED", gate.isGated)
        return gate
    }

    @Test
    fun loudSpeechCommitsOnEverySensitivity() {
        for (level in 0..2) {
            val gate = VoiceGate(level)
            val decisions = frames(gate, -20f, 50)
            assertTrue("sensitivity $level", decisions.all { it == Decision.COMMIT })
            assertFalse("sensitivity $level", gate.isGated)
        }
    }

    @Test
    fun silenceKeepsPostRollThenGatesAfterTwoSeconds() {
        val gate = VoiceGate(1)
        frames(gate, -20f, 30)
        val postRollFrames = frames(gate, -90f, POST_ROLL_MS / FRAME_MS)
        assertTrue("first ${POST_ROLL_MS}ms of silence is still committed", postRollFrames.all { it == Decision.COMMIT })

        // Silence keeps being skipped (HOLD) but the gate only reports GATED after the hangover.
        var gatedAt = -1
        for (frame in 0 until HANG_MS / FRAME_MS + 10) {
            val decision = gate.evaluate(-90f)
            assertEquals(Decision.HOLD, decision)
            if (gate.isGated) { gatedAt = frame + postRollFrames.size + 1; break }
            assertFalse("must not gate early (frame $frame)", gate.isGated)
        }
        assertEquals("gate closes after exactly ${HANG_MS}ms of silence", HANG_MS / FRAME_MS, gatedAt)
    }

    @Test
    fun quietSensitivityOpensOnSpeechThatNoisyRejects() {
        val quiet = gatedGate(0)   // start threshold: max(-60+6, -50) = -50 dBFS
        val noisy = gatedGate(2)   // start threshold: max(-60+14, -38) = -38 dBFS

        val quietDecisions = frames(quiet, -48f, 3)
        assertEquals(listOf(Decision.HOLD, Decision.HOLD, Decision.COMMIT_WITH_PRE_ROLL), quietDecisions)
        assertFalse(quiet.isGated)

        val noisyDecisions = frames(noisy, -48f, 20)
        assertTrue(noisyDecisions.all { it == Decision.HOLD })
        assertTrue("noise-rejecting stays gated on the same level", noisy.isGated)
    }

    @Test
    fun gatedGateNeedsThreeVotesInsideTheWindowToReopen() {
        val gate = gatedGate(1)    // start threshold: max(-60+10, -45) = -45 dBFS

        // Two stray positives alone never open the gate.
        assertEquals(Decision.HOLD, gate.evaluate(-40f))
        assertEquals(Decision.HOLD, gate.evaluate(-40f))
        assertTrue(gate.isGated)
        // Let them age out of the 5-frame window.
        frames(gate, -90f, CONFIRM_WINDOW)
        assertTrue(gate.isGated)

        assertEquals(Decision.HOLD, gate.evaluate(-40f))
        assertEquals(Decision.HOLD, gate.evaluate(-40f))
        assertEquals("third positive inside the window reopens", Decision.COMMIT_WITH_PRE_ROLL, gate.evaluate(-40f))
        assertFalse(gate.isGated)
    }

    @Test
    fun armedGateResumesOnASingleLoudFrame() {
        val gate = VoiceGate(1)
        frames(gate, -20f, 30)
        frames(gate, -90f, POST_ROLL_MS / FRAME_MS + 1)   // one HOLD past the post-roll: ARMED
        assertFalse(gate.isGated)

        assertEquals(Decision.COMMIT_WITH_PRE_ROLL, gate.evaluate(-20f))
        assertFalse(gate.isGated)
        // Speech right after resume is held by the minimum-active window even if it dips quiet.
        assertEquals(Decision.COMMIT, gate.evaluate(-90f))
    }

    @Test
    fun primeCommitsSilenceSoAManualResumeKeepsItsFirstWord() {
        val gate = gatedGate(1)
        gate.prime()
        val decisions = frames(gate, -90f, MIN_ACTIVE_HOLD_MS / FRAME_MS)
        assertTrue("prime holds committing for ${MIN_ACTIVE_HOLD_MS}ms", decisions.all { it == Decision.COMMIT })
        assertFalse(gate.isGated)
    }

    @Test
    fun rejectedNoiseRaisesTheStartThreshold() {
        val adapted = gatedGate(1)
        // -48 dB is rejected at the -45 start threshold, and each rejection pulls the
        // floor up toward -48, so the effective start threshold rises to about -38.
        frames(adapted, -48f, 300)
        assertTrue(adapted.isGated)
        // -42 dB would open a fresh gate but no longer opens the adapted one.
        frames(adapted, -42f, 10)
        assertTrue("adapted gate stays closed", adapted.isGated)

        val fresh = gatedGate(1)
        assertEquals(Decision.HOLD, fresh.evaluate(-42f))
        assertEquals(Decision.HOLD, fresh.evaluate(-42f))
        assertEquals("fresh gate opens at -42 dBFS", Decision.COMMIT_WITH_PRE_ROLL, fresh.evaluate(-42f))
    }
}
