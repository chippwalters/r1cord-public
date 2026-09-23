package com.chippwalters.r1cord.sync

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Desktop-server preferences. Plain keys share "app_preferences" with RecorderSettings;
 * the bearer token is stored separately in EncryptedSharedPreferences.
 */
object OffloadSettings {
    private const val PREFS = "app_preferences"
    private const val SECURE_PREFS = "offload_secure"
    private const val KEY_SERVER_URL = "offload_server_url"
    private const val KEY_DEFAULT_SUMMARIZE = "offload_default_summarize"
    private const val KEY_DEFAULT_PUBLISH = "offload_default_publish"
    private const val KEY_DEFAULT_STYLE = "offload_default_style"
    private const val KEY_SERVER_NAME = "offload_server_name"
    private const val KEY_TOKEN = "token"
    private const val STYLE_NOTES = "notes"
    private val STYLES = setOf("notes", "minutes", "article")

    @Volatile private var securePrefs: SharedPreferences? = null

    fun serverUrl(context: Context): String = prefs(context).getString(KEY_SERVER_URL, "") ?: ""

    fun setServerUrl(context: Context, url: String) {
        prefs(context).edit().putString(KEY_SERVER_URL, url.trim()).apply()
    }

    fun defaultSummarize(context: Context): Boolean = prefs(context).getBoolean(KEY_DEFAULT_SUMMARIZE, true)

    fun setDefaultSummarize(context: Context, enabled: Boolean) {
        prefs(context).edit().putBoolean(KEY_DEFAULT_SUMMARIZE, enabled).apply()
    }

    fun defaultPublish(context: Context): Boolean = prefs(context).getBoolean(KEY_DEFAULT_PUBLISH, true)

    fun setDefaultPublish(context: Context, enabled: Boolean) {
        prefs(context).edit().putBoolean(KEY_DEFAULT_PUBLISH, enabled).apply()
    }

    fun defaultStyle(context: Context): String {
        val value = prefs(context).getString(KEY_DEFAULT_STYLE, STYLE_NOTES) ?: STYLE_NOTES
        return if (value in STYLES) value else STYLE_NOTES
    }

    fun setDefaultStyle(context: Context, style: String) {
        val value = if (style in STYLES) style else STYLE_NOTES
        prefs(context).edit().putString(KEY_DEFAULT_STYLE, value).apply()
    }

    fun serverName(context: Context): String = prefs(context).getString(KEY_SERVER_NAME, "") ?: ""

    fun setServerName(context: Context, name: String) {
        prefs(context).edit().putString(KEY_SERVER_NAME, name).apply()
    }

    fun token(context: Context): String? = secure(context).getString(KEY_TOKEN, null)?.takeIf { it.isNotBlank() }

    fun setToken(context: Context, token: String) {
        secure(context).edit().putString(KEY_TOKEN, token).apply()
    }

    fun clearToken(context: Context) {
        secure(context).edit().remove(KEY_TOKEN).apply()
    }

    fun isPaired(context: Context): Boolean = token(context) != null

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
