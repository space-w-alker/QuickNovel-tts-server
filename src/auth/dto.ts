import { IsIn, IsNotEmpty, IsString, IsUUID, MaxLength } from 'class-validator';

export class RegisterInstallationDto {
  @IsUUID()
  installation_id!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  app_version!: string;

  @IsIn(['android'])
  platform!: 'android';
}

export class RefreshInstallationDto {
  @IsUUID()
  installation_id!: string;

  @IsString()
  @IsNotEmpty()
  refresh_token!: string;
}
