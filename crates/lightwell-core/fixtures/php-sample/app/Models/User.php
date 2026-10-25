<?php

namespace App\Models;

// café 日本語
use Acme\Legacy\Widget;

class User
{
    public function name(): string
    {
        return "ada";
    }
}

function user_label(): string
{
    return "user";
}
