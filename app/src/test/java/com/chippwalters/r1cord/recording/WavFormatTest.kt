package com.chippwalters.r1cord.recording

import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/** RIFF/WAVE container contract: header layout, size patching, and the 4 GiB stop limit. */
class WavFormatTest {
    @get:Rule val temp = TemporaryFolder()

    private fun header(dataBytes: Long) = buildWavHeader(dataBytes).order(ByteOrder.LITTLE_ENDIAN)

    private fun ascii(bytes: ByteBuffer, offset: Int, length: Int) =
        String(ByteArray(length) { bytes.get(offset + it) }, Charsets.US_ASCII)

    @Test
    fun headerIsAStandard48kMonoPcm16RiffLayout() {
        val h = header(0L)
        assertEquals(WAV_HEADER_BYTES, h.remaining())
        assertEquals("RIFF", ascii(h, 0, 4))
        assertEquals("WAVE", ascii(h, 8, 4))
        assertEquals("fmt ", ascii(h, 12, 4))
        assertEquals(16, h.getInt(16))       // PCM chunk size
        assertEquals(1, h.getShort(20).toInt())   // format: PCM
        assertEquals(1, h.getShort(22).toInt())   // channels: mono
        assertEquals(48_000, h.getInt(24))   // sample rate
        assertEquals(96_000, h.getInt(28))   // byte rate: 48000 * 2
        assertEquals(2, h.getShort(32).toInt())   // block align
        assertEquals(16, h.getShort(34).toInt())  // bits per sample
        assertEquals("data", ascii(h, 36, 4))
        assertEquals(0, h.getInt(40))        // placeholder until finish()
        assertEquals(36, h.getInt(4))        // placeholder RIFF size: header - 8
    }

    @Test
    fun headerSizesMatchTheDataLength() {
        val h = header(1_000_000L)
        assertEquals(36 + 1_000_000, h.getInt(4))
        assertEquals(1_000_000, h.getInt(40))
    }

    @Test
    fun limitIsJustUnderFourGibAndTheMaxHeaderDoesNotWrap() {
        assertEquals(0xFFFF_FFFFL - 44, WAV_MAX_DATA_BYTES)
        val h = header(WAV_MAX_DATA_BYTES)
        val riffSize = 36L + WAV_MAX_DATA_BYTES
        val dataSize = WAV_MAX_DATA_BYTES
        assertTrue("RIFF size must fit unsigned 32-bit", riffSize <= 0xFFFF_FFFFL)
        assertTrue("data size must fit unsigned 32-bit", dataSize <= 0xFFFF_FFFFL)
        assertEquals((riffSize and 0xFFFF_FFFFL).toInt(), h.getInt(4))
        assertEquals((dataSize and 0xFFFF_FFFFL).toInt(), h.getInt(40))
    }

    @Test
    fun overflowCheckAcceptsTheLargestFrameAndRejectsOneMoreByte() {
        val committedAtLimit = WAV_MAX_DATA_BYTES / 2   // samples: two bytes each
        val lastFrame = (WAV_MAX_DATA_BYTES - committedAtLimit * 2).toInt()
        assertFalse(wavDataWouldOverflow(committedAtLimit, lastFrame))
        assertTrue(wavDataWouldOverflow(committedAtLimit, lastFrame + 1))
        assertFalse("an empty recording accepts its first frame", wavDataWouldOverflow(0L, FRAME_BYTES))
        assertTrue("past the limit every frame is refused", wavDataWouldOverflow(committedAtLimit + 1, FRAME_BYTES))
    }

    @Test
    fun writerStreamsDataAndFinishPatchesBothSizeFields() {
        val file = temp.newFile("out.wav")
        val pcm = ByteArray(4_800) { (it % 251).toByte() }
        FileOutputStream(file).use { out ->
            val writer = WavWriter(out.fd)
            writer.open()
            writer.write(pcm, pcm.size)
            writer.finish(pcm.size.toLong())
        }
        val bytes = file.readBytes()
        assertEquals(WAV_HEADER_BYTES + pcm.size, bytes.size)
        val h = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        assertEquals("RIFF", String(bytes, 0, 4, Charsets.US_ASCII))
        assertEquals(36 + pcm.size, h.getInt(4))
        assertEquals("data", String(bytes, 36, 4, Charsets.US_ASCII))
        assertEquals(pcm.size, h.getInt(40))
        assertTrue("payload survives verbatim", pcm.indices.all { bytes[WAV_HEADER_BYTES + it] == pcm[it] })
    }

    @Test
    fun reopeningTruncatesStaleBytesFromAnEarlierSession() {
        val file = temp.newFile("stale.wav")
        val stale = ByteArray(100) { 7 }
        FileOutputStream(file).use { out ->
            WavWriter(out.fd).apply {
                open(); write(stale, stale.size); finish(stale.size.toLong())
            }
        }
        val fresh = ByteArray(10) { 9 }
        FileOutputStream(file).use { out ->
            WavWriter(out.fd).apply {
                open(); write(fresh, fresh.size); finish(fresh.size.toLong())
            }
        }
        val bytes = file.readBytes()
        assertEquals(WAV_HEADER_BYTES + fresh.size, bytes.size)
        assertEquals(fresh.size, ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).getInt(40))
    }
}
