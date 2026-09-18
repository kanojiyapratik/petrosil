<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * The four permissions the price-batch screens and API check for.
 *
 * A migration rather than a seeder because they are not sample data: without
 * them every price endpoint answers 403, including for the super-admin, and
 * the site looks broken rather than unconfigured. Written to be safe to run
 * twice -- it inserts only what is missing.
 */
class AddPriceBatchPermissions extends Migration
{
    /** Exactly the set baseoil grants, so the two sites stay comparable. */
    const PERMISSIONS = [
        'price-batch-view',
        'price-batch-create',
        'price-batch-commit',
        'price-batch-rollback',
    ];

    const ROLE = 'super-admin';

    public function up()
    {
        $guard = DB::table('permissions')->value('guard_name') ?: 'web';

        foreach (self::PERMISSIONS as $name) {
            $exists = DB::table('permissions')->where('name', $name)->exists();

            if (!$exists) {
                DB::table('permissions')->insert([
                    'name'       => $name,
                    'guard_name' => $guard,
                    'created_at' => now(),
                    'updated_at' => now(),
                ]);
            }
        }

        $roleId = DB::table('roles')->where('name', self::ROLE)->value('id');

        if ($roleId === null) {
            return;
        }

        foreach (self::PERMISSIONS as $name) {
            $permissionId = DB::table('permissions')->where('name', $name)->value('id');

            if ($permissionId === null) {
                continue;
            }

            $granted = DB::table('role_has_permissions')
                ->where('role_id', $roleId)
                ->where('permission_id', $permissionId)
                ->exists();

            if (!$granted) {
                DB::table('role_has_permissions')->insert([
                    'role_id'       => $roleId,
                    'permission_id' => $permissionId,
                ]);
            }
        }
    }

    public function down()
    {
        $ids = DB::table('permissions')->whereIn('name', self::PERMISSIONS)->pluck('id');

        DB::table('role_has_permissions')->whereIn('permission_id', $ids)->delete();
        DB::table('permissions')->whereIn('name', self::PERMISSIONS)->delete();
    }
}
