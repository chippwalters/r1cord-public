package com.chippwalters.r1cord.recording

import android.content.Context
import android.os.Looper
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import com.chippwalters.r1cord.model.PlaybackState
import com.chippwalters.r1cord.model.RecordingItem
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

class PlaybackController(context: Context) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val mutableState = MutableStateFlow(PlaybackState())
    val state: StateFlow<PlaybackState> = mutableState.asStateFlow()
    private var ticker: Job? = null
    private var released = false
    private val player = ExoPlayer.Builder(context.applicationContext).build().apply {
        setAudioAttributes(AudioAttributes.Builder().setContentType(C.AUDIO_CONTENT_TYPE_SPEECH).setUsage(C.USAGE_MEDIA).build(), true)
        setHandleAudioBecomingNoisy(true)
        addListener(object : Player.Listener {
            override fun onEvents(player: Player, events: Player.Events) {
                refresh()
                if (player.isPlaying && ticker == null) {
                    ticker = scope.launch { while (true) { refresh(); delay(200) } }
                } else if (!player.isPlaying) { ticker?.cancel(); ticker = null }
            }
            override fun onPlayerError(error: PlaybackException) {
                mutableState.value = state.value.copy(isPlaying = false, error = "Could not play audio. It may have been removed or interrupted: ${error.errorCodeName}")
                ticker?.cancel()
                ticker = null
            }
        })
    }

    fun prepare(item: RecordingItem) = onMain {
        player.pause()
        prepareItem(item)
        refresh()
    }

    // Only an explicit user Play command starts playback.
    fun play(item: RecordingItem) = onMain {
        if (!prepareItem(item)) return@onMain
        if (player.playbackState == Player.STATE_ENDED) player.seekTo(0)
        player.play()
    }

    private fun prepareItem(item: RecordingItem): Boolean {
        if (item.audioUri.isBlank() || item.status !in setOf("SAVED", "INTERRUPTED")) {
            player.pause()
            player.stop()
            player.clearMediaItems()
            mutableState.value = PlaybackState(recordingId = item.id, error = "This recording has no available finalized audio.")
            return false
        }
        if (player.currentMediaItem?.mediaId != item.id || player.playerError != null || player.playbackState == Player.STATE_IDLE) {
            val position = if (state.value.recordingId == item.id) state.value.positionMs else 0
            player.pause()
            player.stop()
            mutableState.value = PlaybackState(recordingId = item.id, positionMs = position, durationMs = item.durationMs)
            player.setMediaItem(MediaItem.Builder().setMediaId(item.id).setUri(item.audioUri).build(), position)
            player.prepare()
        }
        return true
    }

    fun pause() = onMain { player.pause(); refresh() }
    fun seekTo(ms: Long) = onMain {
        if (player.currentMediaItem == null) return@onMain
        val duration = if (player.duration != C.TIME_UNSET) player.duration.coerceAtLeast(0) else state.value.durationMs
        player.seekTo(ms.coerceIn(0, duration))
        refresh()
    }
    fun stop() = onMain {
        ticker?.cancel()
        ticker = null
        player.stop()
        player.clearMediaItems()
        mutableState.value = PlaybackState()
    }
    fun release() = onMain {
        ticker?.cancel()
        ticker = null
        player.release()
        released = true
        mutableState.value = PlaybackState()
        scope.cancel()
    }

    private fun refresh() {
        if (released) return
        mutableState.value = state.value.copy(
            isPlaying = player.isPlaying,
            positionMs = player.currentPosition.coerceAtLeast(0),
            durationMs = if (player.duration == C.TIME_UNSET) state.value.durationMs else player.duration.coerceAtLeast(0),
        )
    }

    private fun onMain(action: () -> Unit) {
        scope.launch { if (!released) action() }
    }
}
