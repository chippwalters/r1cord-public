package com.chippwalters.r1cord.sync

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.chippwalters.r1cord.model.REVIEW_KINDS
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Whether the device holds a pairing token, and the paired desktop's display name. */
data class PairingSnapshot(val paired: Boolean, val serverName: String)

/**
 * Desktop-server preferences. Plain keys share "app_preferences" with RecorderSettings;
 * the bearer token is stored separately in EncryptedSharedPreferences.
 */
object OffloadSettings {
    private const val PREFS = "app_preferences"
    private const val SECURE_PREFS = "offload_secure"
    private const val KEY_SERVER_URL = "offload_server_url"
    private const val KEY_DEFAULT_REVIEWS = "offload_default_reviews"
    private const val KEY_DEFAULT_PUBLISH = "offload_default_publish"
    private const val KEY_SERVER_NAME = "offload_server_name"
    private const val KEY_TOKEN = "token"
    /** 0.3.2 and earlier stored a Summarize switch and a summary style; the switch seeds the reviews once. */
    private const val LEGACY_SUMMARIZE = "offload_default_summarize"
    private const val LEGACY_STYLE = "offload_default_style"

    /** Tests preset a plain SharedPreferences here: Robolectric has no AndroidKeyStore. */
    @Volatile internal var securePrefs: SharedPreferences? = null
    private val pairingState = MutableStateFlow(PairingSnapshot(paired = false, serverName = ""))

    /**
     * Process-wide pairing state. Every writer (in-app pairing, unpairing, USB provisioning on
     * a binder thread) republishes it, so observers see pairings they did not initiate.
     * Each call re-reads the stored values first, so the returned value is current.
     */
    fun pairing(context: Context): StateFlow<PairingSnapshot> {
        publishPairing(context)
        return pairingState.asStateFlow()
    }

    fun serverUrl(context: Context): String = prefs(context).getString(KEY_SERVER_URL, "") ?: ""

    fun setServerUrl(context: Context, url: String) {
        prefs(context).edit().putString(KEY_SERVER_URL, url.trim()).apply()
    }

    /** AI reviews the Send sheet starts with, in canonical order. */
    fun defaultReviews(context: Context): List<String> {
        val prefs = prefs(context)
        val stored = prefs.getStringSet(KEY_DEFAULT_REVIEWS, null)
            ?: return if (prefs.getBoolean(LEGACY_SUMMARIZE, true)) listOf("summary") else emptyList()
        return REVIEW_KINDS.filter { it in stored }
    }

    fun setDefaultReviews(context: Context, reviews: Collection<String>) {
        prefs(context).edit()
            .putStringSet(KEY_DEFAULT_REVIEWS, REVIEW_KINDS.filter { it in reviews }.toSet())
            .remove(LEGACY_SUMMARIZE)
            .remove(LEGACY_STYLE)
            .apply()
    }

    fun defaultPublish(context: Context): Boolean = prefs(context).getBoolean(KEY_DEFAULT_PUBLISH, true)

    fun setDefaultPublish(context: Context, enabled: Boolean) {
        prefs(context).edit().putBoolean(KEY_DEFAULT_PUBLISH, enabled).apply()
    }

    fun serverName(context: Context): String = prefs(context).getString(KEY_SERVER_NAME, "") ?: ""

    fun setServerName(context: Context, name: String) {
        prefs(context).edit().putString(KEY_SERVER_NAME, name).apply()
        publishPairing(context)
    }

    fun token(context: Context): String? = secure(context).getString(KEY_TOKEN, null)?.takeIf { it.isNotBlank() }

    fun setToken(context: Context, token: String) {
        secure(context).edit().putString(KEY_TOKEN, token).apply()
        publishPairing(context)
    }

    fun clearToken(context: Context) {
        secure(context).edit().remove(KEY_TOKEN).apply()
        publishPairing(context)
    }

    fun isPaired(context: Context): Boolean = token(context) != null

    /**
     * Pairs with a desktop in one step (USB setup): server URL, server name and token change
     * together. Written synchronously; if the URL/name write fails the previous token is restored,
     * so a half-applied pairing never pairs the old server with the new token. Throws on failure.
     */
    fun provision(context: Context, serverUrl: String, serverName: String, token: String) {
        require(token.isNotBlank()) { "Token is required." }
        val secure = secure(context)
        val previous = secure.getString(KEY_TOKEN, null)
        check(secure.edit().putString(KEY_TOKEN, token).commit()) { "Could not save the pairing token." }
        val saved = prefs(context).edit()
            .putString(KEY_SERVER_URL, serverUrl.trim())
            .putString(KEY_SERVER_NAME, serverName)
            .commit()
        if (!saved) {
            secure.edit().apply { if (previous == null) remove(KEY_TOKEN) else putString(KEY_TOKEN, previous) }.commit()
            error("Could not save the server settings.")
        }
        publishPairing(context)
    }

    /**
     * Re-reads the stored pairing and publishes it. Read and publish happen under one lock, so
     * concurrent writers (UI thread, binder thread) can never leave an older snapshot published
     * after a newer one: the last publisher reads after every earlier write.
     */
    private fun publishPairing(context: Context) {
        synchronized(pairingState) {
            pairingState.value = PairingSnapshot(paired = isPaired(context), serverName = serverName(context))
        }
    }

    private fun prefs(context: Context) =
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun secure(context: Context): SharedPreferences {
        securePrefs?.let { return it }
        synchronized(this) {
            securePrefs?.let { return it }
            val app = context.applicationContext
            val masterKey = MasterKey.Builder(app)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build()
            return EncryptedSharedPreferences.create(
                app,
                SECURE_PREFS,
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
            ).also { securePrefs = it }
        }
    }
}
