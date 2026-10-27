package com.example.app

import com.example.lib.Util

/*
fun hidden() {}
*/
object Greeter {
    fun nested(): String = Util.greet()
}

fun hello(): String = Greeter.nested()
