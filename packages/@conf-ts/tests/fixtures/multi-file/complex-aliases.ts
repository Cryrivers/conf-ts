import { HELPER_CONSTANT, HELPER_NUMBER } from '@utils/helper';



import { MY_CONSTANT } from '@/constants';
import { MultiFileEnum } from '@/enums';





enum KycInfoField {
  /** Basic Info */
  FullName = 1,
  FirstName = 2,
  LastName = 3,
  Dob = 4,
  IdType = 5,
  IdIssuingCountry = 6,
  IdNumber = 7,
  IdIssueDate = 8,
  IdExpireDate = 15,
  /** Address Info */
  ResidencyCountry = 9,
  ResidencyCity = 10,
  ResidencyAddressDetail = 11,
  ResidencyLineOne = 12,
  ResidencyLineTwo = 13,
  ResidencyPostalCode = 14,
}

export const displayKycInfoConfig = {
  basic_info: [
    {
      field: KycInfoField.FullName,
    },
    {
      field: KycInfoField.Dob,
    },
    {
      field: KycInfoField.IdType,
    },
    {
      field: KycInfoField.IdIssuingCountry,
    },
    {
      field: KycInfoField.IdNumber,
    },
    {
      field: KycInfoField.IdIssueDate,
    },
  ],
  address_info: [
    {
      field: KycInfoField.ResidencyCountry,
    },
    {
      field: KycInfoField.ResidencyCity,
    },
    {
      field: KycInfoField.ResidencyAddressDetail,
    },
  ],
};

export default {
  value1: MY_CONSTANT + MultiFileEnum.Value,
  value2: HELPER_CONSTANT + ' ' + HELPER_NUMBER,
  nested: {
    enumValue: MultiFileEnum.Value,
    constant: MY_CONSTANT,
    helper: HELPER_CONSTANT,
    number: HELPER_NUMBER,
  },
};