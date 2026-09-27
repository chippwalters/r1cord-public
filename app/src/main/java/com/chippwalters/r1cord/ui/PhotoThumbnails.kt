package com.chippwalters.r1cord.ui

import android.content.ContentResolver
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import android.util.LruCache
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.chippwalters.r1cord.model.PhotoItem
import kotlin.coroutines.cancellation.CancellationException
import kotlin.math.ceil
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext

/**
 * Process-wide cache of small, downsampled first-photo thumbnails.
 *
 * Bitmaps are never recycled here: an evicted or invalidated bitmap may still be drawn by Compose,
 * so it is simply dropped and left to the GC. Full-size gallery/detail images do not use this cache.
 */
internal object PhotoThumbnails {
    /** Byte budget for every cached thumbnail together. */
    const val MAX_CACHE_BYTES = 2 * 1024 * 1024

    /** A single entry larger than this (e.g. a panorama) is shown but never cached. */
    const val MAX_ENTRY_BYTES = MAX_CACHE_BYTES / 8

    /** Decode targets (px) for the shortest thumbnail edge; small slots still get a crisp source. */
    const val MIN_TARGET_PX = 96
    const val MAX_TARGET_PX = 160

    private const val MAX_CONCURRENT_DECODES = 2

    private val cache = object : LruCache<String, Bitmap>(MAX_CACHE_BYTES) {
        override fun sizeOf(key: String, value: Bitmap): Int = value.byteCount
    }
    private val decodes = Semaphore(MAX_CONCURRENT_DECODES)

    fun key(uri: String, targetPx: Int): String = "$targetPx|$uri"

    /** Decode target for a thumbnail slot [slotPx] pixels wide. */
    fun targetPx(slotPx: Float): Int {
        val px = if (slotPx.isFinite()) ceil(slotPx).toInt() else 0
        return px.coerceIn(MIN_TARGET_PX, MAX_TARGET_PX)
    }

    /**
     * Size that makes the shorter edge of a [width]×[height] image equal [target] while keeping its
     * aspect ratio; images whose shorter edge is already at or below [target] keep their size.
     */
    fun coverSize(width: Int, height: Int, target: Int): Pair<Int, Int> {
        val shortest = minOf(width, height)
        if (shortest <= target || target <= 0) return width to height
        val scaledWidth = (width.toLong() * target / shortest).toInt().coerceAtLeast(1)
        val scaledHeight = (height.toLong() * target / shortest).toInt().coerceAtLeast(1)
        return scaledWidth to scaledHeight
    }

    fun cached(uri: String, targetPx: Int): Bitmap? = cache.get(key(uri, targetPx))

    /** Stores [bitmap] under [key] unless it is too large for the shared budget. Returns true when cached. */
    fun offer(key: String, bitmap: Bitmap): Boolean {
        if (bitmap.byteCount > MAX_ENTRY_BYTES) return false
        cache.put(key, bitmap)
        return true
    }

    /** Drops every cached size of [uri] (e.g. the photo was deleted). Nothing is recycled. */
    fun invalidate(uri: String) {
        cache.snapshot().keys.forEach { key -> if (key.substringAfter('|') == uri) cache.remove(key) }
    }

    internal fun clear() = cache.evictAll()

    internal fun cachedBytes(): Int = cache.size()

    /**
     * Returns the thumbnail for [uri], decoding it off the main thread when it is not cached.
     * At most [MAX_CONCURRENT_DECODES] decodes run at once. A decode that completes after its
     * caller was cancelled still lands in the cache, so the work is not repeated.
     */
    suspend fun load(resolver: ContentResolver, uri: String, targetPx: Int): Bitmap {
        val key = key(uri, targetPx)
        cache.get(key)?.let { return it }
        return decodes.withPermit {
            cache.get(key) ?: withContext(Dispatchers.IO) {
                scaleToCover(loadPhoto(resolver, uri, targetPx), targetPx).also { offer(key, it) }
            }
        }
    }

    /** Downscales a freshly decoded, not-yet-shared bitmap; the intermediate is recycled. */
    private fun scaleToCover(bitmap: Bitmap, target: Int): Bitmap {
        val (width, height) = coverSize(bitmap.width, bitmap.height, target)
        if (width == bitmap.width && height == bitmap.height) return bitmap
        return Bitmap.createScaledBitmap(bitmap, width, height, true).also {
            if (it !== bitmap) bitmap.recycle()
        }
    }
}

private sealed interface ThumbState {
    data object Loading : ThumbState
    data object Failed : ThumbState
    data class Ready(val bitmap: Bitmap) : ThumbState
}

/**
 * Square, cropped thumbnail of [photo]. Renders nothing and takes no space when [photo] is null;
 * a photo that cannot be read shows a small neutral placeholder.
 */
@Composable
internal fun PhotoThumb(photo: PhotoItem?, size: Dp, modifier: Modifier = Modifier, contentDescription: String? = null) {
    if (photo == null) return
    val resolver = LocalContext.current.contentResolver
    val targetPx = with(LocalDensity.current) { PhotoThumbnails.targetPx(size.toPx()) }
    val uri = photo.uri
    val initial = remember(uri, targetPx) {
        PhotoThumbnails.cached(uri, targetPx)?.let { ThumbState.Ready(it) } ?: ThumbState.Loading
    }
    val state by produceState(initial, uri, targetPx) {
        val hit = PhotoThumbnails.cached(uri, targetPx)
        if (hit != null) {
            value = ThumbState.Ready(hit)
            return@produceState
        }
        value = ThumbState.Loading
        value = try {
            ThumbState.Ready(PhotoThumbnails.load(resolver, uri, targetPx))
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Throwable) {
            ThumbState.Failed
        }
    }
    Box(modifier.size(size).clip(RoundedCornerShape(8.dp)).background(Border), contentAlignment = Alignment.Center) {
        when (val current = state) {
            is ThumbState.Ready -> {
                val image = remember(current.bitmap) { current.bitmap.asImageBitmap() }
                Image(image, contentDescription = contentDescription, modifier = Modifier.fillMaxSize(),
                    contentScale = ContentScale.Crop)
            }
            ThumbState.Failed -> Icon(Icons.Outlined.Image, contentDescription = null, tint = Muted,
                modifier = Modifier.size(size / 2))
            ThumbState.Loading -> Unit
        }
    }
}

/** Decodes [value] subsampled so its longest edge is at least [target] px, honouring EXIF orientation. */
internal fun loadPhoto(resolver: ContentResolver, value: String, target: Int): Bitmap {
    val uri = Uri.parse(value)
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    val boundsStream = resolver.openInputStream(uri) ?: error("Photo cannot be opened")
    boundsStream.use { BitmapFactory.decodeStream(it, null, bounds) }
    require(bounds.outWidth > 0 && bounds.outHeight > 0) { "Invalid photo" }
    var sample = 1
    while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= target) sample *= 2
    val options = BitmapFactory.Options().apply { inSampleSize = sample }
    val bitmap = resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, options) }
        ?: error("Photo cannot be decoded")
    val orientation = resolver.openInputStream(uri)?.use {
        ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
    } ?: ExifInterface.ORIENTATION_NORMAL
    val matrix = Matrix()
    when (orientation) {
        ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> matrix.setScale(-1f, 1f)
        ExifInterface.ORIENTATION_ROTATE_180 -> matrix.setRotate(180f)
        ExifInterface.ORIENTATION_FLIP_VERTICAL -> matrix.setScale(1f, -1f)
        ExifInterface.ORIENTATION_TRANSPOSE -> { matrix.setRotate(90f); matrix.postScale(-1f, 1f) }
        ExifInterface.ORIENTATION_ROTATE_90 -> matrix.setRotate(90f)
        ExifInterface.ORIENTATION_TRANSVERSE -> { matrix.setRotate(270f); matrix.postScale(-1f, 1f) }
        ExifInterface.ORIENTATION_ROTATE_270 -> matrix.setRotate(270f)
    }
    if (matrix.isIdentity) return bitmap
    return Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true).also {
        if (it !== bitmap) bitmap.recycle()
    }
}
