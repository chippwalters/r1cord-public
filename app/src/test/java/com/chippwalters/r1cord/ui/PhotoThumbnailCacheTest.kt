package com.chippwalters.r1cord.ui

import android.graphics.Bitmap
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** Byte-bounded first-photo thumbnail cache: decode targets, cover sizing, eviction and invalidation. */
@RunWith(RobolectricTestRunner::class)
class PhotoThumbnailCacheTest {
    @Before @After fun emptyCache() = PhotoThumbnails.clear()

    private fun bitmap(width: Int, height: Int): Bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)

    @Test
    fun decodeTargetIsTheSlotSizeClampedToTheThumbnailRange() {
        assertEquals("a 40dp slot at 200dpi still decodes a crisp source", 96, PhotoThumbnails.targetPx(50f))
        assertEquals(96, PhotoThumbnails.targetPx(96f))
        assertEquals("partial pixels round up", 121, PhotoThumbnails.targetPx(120.2f))
        assertEquals(160, PhotoThumbnails.targetPx(160f))
        assertEquals("large slots never decode big images into the small cache", 160, PhotoThumbnails.targetPx(1_000f))
        assertEquals(96, PhotoThumbnails.targetPx(Float.NaN))
        assertEquals(96, PhotoThumbnails.targetPx(Float.POSITIVE_INFINITY))
    }

    @Test
    fun coverSizeShrinksTheShortEdgeToTheTargetKeepingAspect() {
        assertEquals(128 to 96, PhotoThumbnails.coverSize(400, 300, 96))
        assertEquals("portrait photos keep orientation", 96 to 128, PhotoThumbnails.coverSize(300, 400, 96))
        assertEquals(96 to 96, PhotoThumbnails.coverSize(4_000, 4_000, 96))
    }

    @Test
    fun coverSizeNeverUpscales() {
        assertEquals(96 to 72, PhotoThumbnails.coverSize(96, 72, 96))
        assertEquals("short edge exactly at target is kept", 128 to 96, PhotoThumbnails.coverSize(128, 96, 96))
        assertEquals(10 to 1, PhotoThumbnails.coverSize(10, 1, 96))
    }

    @Test
    fun keysSeparateSizesOfTheSamePhoto() {
        val uri = "content://media/external/images/media/7"
        PhotoThumbnails.offer(PhotoThumbnails.key(uri, 96), bitmap(128, 96))
        assertNotNull(PhotoThumbnails.cached(uri, 96))
        assertNull(PhotoThumbnails.cached(uri, 120))
    }

    @Test
    fun oversizedEntriesAreNotCached() {
        val uri = "content://media/external/images/media/panorama"
        // 400 * 400 * 4 bytes = 640 KB, above the per-entry limit.
        val big = bitmap(400, 400)
        assertTrue(big.byteCount > PhotoThumbnails.MAX_ENTRY_BYTES)
        assertFalse(PhotoThumbnails.offer(PhotoThumbnails.key(uri, 160), big))
        assertNull(PhotoThumbnails.cached(uri, 160))
        assertEquals(0, PhotoThumbnails.cachedBytes())
    }

    @Test
    fun cacheStaysWithinItsByteBudgetEvictingOldestWithoutRecycling() {
        val entries = (0 until 80).map { index ->
            val uri = "content://media/external/images/media/$index"
            val thumb = bitmap(128, 96) // 48 KB each; 80 of them exceed the 2 MiB budget.
            assertTrue(PhotoThumbnails.offer(PhotoThumbnails.key(uri, 96), thumb))
            uri to thumb
        }
        assertTrue(PhotoThumbnails.cachedBytes() <= PhotoThumbnails.MAX_CACHE_BYTES)
        val (firstUri, firstBitmap) = entries.first()
        val (lastUri, lastBitmap) = entries.last()
        assertNull("least recently used entry is evicted", PhotoThumbnails.cached(firstUri, 96))
        assertSame(lastBitmap, PhotoThumbnails.cached(lastUri, 96))
        assertFalse("an evicted bitmap may still be on screen, so it is never recycled", firstBitmap.isRecycled)
    }

    @Test
    fun recentlyReadEntriesSurviveEviction() {
        val keep = "content://media/external/images/media/keep"
        PhotoThumbnails.offer(PhotoThumbnails.key(keep, 96), bitmap(128, 96))
        repeat(80) { index ->
            PhotoThumbnails.cached(keep, 96)
            PhotoThumbnails.offer(PhotoThumbnails.key("content://media/external/images/media/$index", 96), bitmap(128, 96))
        }
        assertNotNull(PhotoThumbnails.cached(keep, 96))
    }

    @Test
    fun invalidateDropsEverySizeOfOnlyThatPhoto() {
        val deleted = "content://media/external/images/media/1"
        val similar = "content://media/external/images/media/12"
        val deletedSmall = bitmap(128, 96)
        PhotoThumbnails.offer(PhotoThumbnails.key(deleted, 96), deletedSmall)
        PhotoThumbnails.offer(PhotoThumbnails.key(deleted, 120), bitmap(160, 120))
        PhotoThumbnails.offer(PhotoThumbnails.key(similar, 96), bitmap(128, 96))

        PhotoThumbnails.invalidate(deleted)

        assertNull(PhotoThumbnails.cached(deleted, 96))
        assertNull(PhotoThumbnails.cached(deleted, 120))
        assertNotNull("a URI sharing a prefix is untouched", PhotoThumbnails.cached(similar, 96))
        assertFalse(deletedSmall.isRecycled)
    }
}
